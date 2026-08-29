import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { makeFullPipeline, GOOD_SITE } from './helpers/pipeline.js';
import { Workspace } from '../src/website/workspace.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

const log = createLogger('error');
const cleanups: string[] = [];

afterEach(() => {
  for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function workspaceFor(base: string, jobId: string): Workspace {
  const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);
  return Workspace.open(path.resolve(base), jobId, config.execTimeoutMs);
}

function gitReset(root: string, hash: string): void {
  execFileSync('git', ['reset', '--hard', hash], { cwd: root });
}

async function driveToReadyForProduction(jobId: string, p: Awaited<ReturnType<typeof makeFullPipeline>>): Promise<void> {
  await p.drive(); // build → PASS → preview → AWAITING_CLIENT_APPROVAL
  await p.world.conversationsService.recordInboundReply({
    fromEmail: 'owner@acmebakery.example.com',
    body: 'This looks great, I approve it. Please go live.',
    externalId: `approve-${jobId}`,
  });
  p.world.engine.transition(jobId, 'AWAITING_PAYMENT', { actor: 'system', actorType: 'system' });
  p.world.engine.transition(jobId, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider' });
  p.world.engine.transition(jobId, 'READY_FOR_PRODUCTION', { actor: 'system', actorType: 'system' });
}

describe('A3 artifact binding: production deploys exactly the reviewed artifact', () => {
  test('committed mutation after PASS voids the approval (deploy refused + audited)', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await driveToReadyForProduction(p.jobId, p);
    const ws = workspaceFor(p.base, p.jobId);

    // Mutate the artifact: change a file and COMMIT (HEAD moves).
    await ws.writeFile('index.html', GOOD_SITE.files[0]!.content.replace('Welcome to Acme Bakery', 'Welcome to Evil Replacements'));
    await ws.commitRevision('post-review tampering');

    const refused = await p.deploy.deployProduction(p.jobId);
    assert.equal(refused.deployed, false);
    assert.match(refused.reason ?? '', /artifact changed after review PASS/);
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'READY_FOR_PRODUCTION', 'refusal must not advance state');
    assert.ok(
      p.world.audit.listForJob(p.jobId).some((e) => e.action === 'production.deploy_requested' && String(e.details?.['refused']).includes('commit')),
      'refusal must be audited with the commit mismatch',
    );
    assert.ok(!existsSync(path.join(p.productions, p.jobId, 'index.html')), 'nothing may be deployed');
  });

  test('uncommitted content change after PASS voids the approval (content digest)', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await driveToReadyForProduction(p.jobId, p);
    const ws = workspaceFor(p.base, p.jobId);

    // Mutate WITHOUT committing: HEAD unchanged, content digest changes.
    const headBefore = await ws.headCommit();
    await ws.writeFile('extra.html', '<html><body>uncommitted tampering</body></html>');
    assert.equal(await ws.headCommit(), headBefore, 'HEAD must be unchanged for this scenario');

    const refused = await p.deploy.deployProduction(p.jobId);
    assert.equal(refused.deployed, false);
    assert.match(refused.reason ?? '', /artifact content changed after review PASS/);
    assert.ok(!existsSync(path.join(p.productions, p.jobId, 'index.html')), 'nothing may be deployed');
  });

  test('stale PASS must not authorize: PASS@A → revision PASS@C → reset to A refused; HEAD=C deploys', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await p.drive(); // build@A → PASS@A → preview → AWAITING_CLIENT_APPROVAL
    const ws = workspaceFor(p.base, p.jobId);
    const commitA = await ws.headCommit();
    assert.ok(commitA);

    // Client requests changes → revision cycle → PASS@C.
    p.world.engine.transition(p.jobId, 'REVISION_REQUIRED', { actor: 'owner', actorType: 'owner', reason: 'client requests changes' });
    await p.build.buildForJob(p.jobId, { revisionCycle: 1, revisionFeedback: ['Client requested changes'] });
    const reviewed = await p.review.reviewSite(p.jobId, { revisionCycle: 1 });
    assert.equal(reviewed.outcome, 'passed');
    const commitC = await ws.headCommit();
    assert.notEqual(commitC, commitA, 'revision build must produce a new commit');

    const latestPass = p.world.reviews.listByJob(p.jobId).filter((r) => r.verdict === 'PASS').pop();
    assert.equal(latestPass?.artifactCommit, commitC, 'PASS must be bound to commit C');

    // Advance to production-ready with payment confirmed.
    await p.deploy.deployAndSendPreview(p.jobId);
    await p.world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'The revision is approved, please go live.',
      externalId: `approve-2-${p.jobId}`,
    });
    p.world.engine.transition(p.jobId, 'AWAITING_PAYMENT', { actor: 'system', actorType: 'system' });
    p.world.engine.transition(p.jobId, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider' });
    p.world.engine.transition(p.jobId, 'READY_FOR_PRODUCTION', { actor: 'system', actorType: 'system' });

    // (c) Workspace reset to A: latest PASS is C → refused.
    gitReset(path.resolve(p.base, p.jobId), commitA);
    const refused = await p.deploy.deployProduction(p.jobId);
    assert.equal(refused.deployed, false);
    assert.match(refused.reason ?? '', /artifact changed after review PASS/);
    assert.match(refused.reason ?? '', new RegExp(commitC!.slice(0, 7)), 'refusal must name the reviewed commit');

    // (a) HEAD restored to C: deploys exactly the reviewed artifact.
    gitReset(path.resolve(p.base, p.jobId), commitC!);
    const deployed = await p.deploy.deployProduction(p.jobId);
    assert.equal(deployed.deployed, true);
    assert.ok(existsSync(path.join(p.productions, p.jobId, 'index.html')));
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'COMPLETED');
  });
});
