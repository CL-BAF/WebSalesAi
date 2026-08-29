import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, existsSync } from 'node:fs';
import path from 'node:path';
import { SETTING_KEYS } from '../src/db/repositories/settings.js';
import { makeFullPipeline, type FullPipeline } from './helpers/pipeline.js';

void (undefined as unknown as FullPipeline | undefined);

describe('Stages 6+7: review loop, preview and production deployment', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('full happy path: build â†’ PASS â†’ preview deployed + link sent â†’ AWAITING_CLIENT_APPROVAL', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await p.drive();
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'AWAITING_CLIENT_APPROVAL');
    // Preview physically deployed with an entry point.
    const deployment = p.world.db.get<{ url: string }>("SELECT url FROM deployments WHERE kind = 'preview' AND status = 'deployed'");
    assert.ok(deployment?.url);
    const previewDir = p.previews;
    assert.ok(existsSync(path.join(previewDir, p.jobId, 'index.html')));
    assert.ok(!existsSync(path.join(previewDir, p.jobId, '.git')), 'git metadata must not deploy');
    // Preview link email went out.
    assert.ok(p.world.email.sent.some((m) => m.subject === 'Your website preview is ready'));
    assert.ok(p.world.audit.listForJob(p.jobId).some((e) => e.action === 'preview.deployed'));
    assert.ok(p.world.audit.listForJob(p.jobId).some((e) => e.action === 'preview.sent'));
  });

  test('client approval reply â†’ CLIENT_APPROVED; production guarded by payment', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await p.drive();
    // Client replies "approved" â€” positive intent in AWAITING_CLIENT_APPROVAL.
    await p.world.conversationsService.recordInboundReply({
      fromEmail: 'owner@acmebakery.example.com',
      body: 'This looks great, I approve it. Please go live.',
      externalId: 'approve-1',
    });
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'CLIENT_APPROVED');
    p.world.engine.transition(p.jobId, 'AWAITING_PAYMENT', { actor: 'system', actorType: 'system' });

    // Confirm payment → state path READY_FOR_PRODUCTION → production deploy.
    p.world.engine.transition(p.jobId, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider' });
    p.world.engine.transition(p.jobId, 'READY_FOR_PRODUCTION', { actor: 'system', actorType: 'system' });
    const prod = await p.deploy.deployProduction(p.jobId);
    assert.ok(prod.deployed);
    assert.ok(prod.url?.includes('/production/'));
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'COMPLETED');
    assert.ok(existsSync(path.join(p.productions, p.jobId, 'index.html')));
    assert.ok(p.world.audit.listForJob(p.jobId).some((e) => e.action === 'production.deployed'));
  });

  test('production requires review PASS record (defense in depth)', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    // Drive a second job through raw state transitions to READY_FOR_PRODUCTION
    // WITHOUT ever running a review — simulating a lying state.
    const j3 = p.world.engine.getOrCreateJobForLead((await p.world.leads.createLead({ businessName: 'X Co', source: 't', selectionReason: 't' })).lead.id).id;
    for (const state of ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED', 'AWAITING_PAYMENT'] as const) {
      p.world.engine.transition(j3, state, { actor: 'system', actorType: 'system' });
    }
    p.world.engine.transition(j3, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider' });
    p.world.engine.transition(j3, 'READY_FOR_PRODUCTION', { actor: 'system', actorType: 'system' });
    const refused = await p.deploy.deployProduction(j3);
    assert.equal(refused.deployed, false);
    assert.match(refused.reason ?? '', /no review PASS/);
    assert.equal(p.world.jobs.requireById(j3).state, 'READY_FOR_PRODUCTION', 'refusal must not advance state');
  });

  test('M7-1: guard-blocked preview link send is retryable after the guard clears', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    // Engage the kill switch BEFORE the preview link send.
    p.world.settings.setBool(SETTING_KEYS.outreachKillSwitch, true);
    await p.drive();
    const state1 = p.world.jobs.requireById(p.jobId).state;
    assert.equal(state1, 'PREVIEW_READY', 'deployment done, send blocked, state preserved');
    const sentBefore = p.world.email.sent.filter((m) => m.subject === 'Your website preview is ready').length;
    assert.equal(sentBefore, 0);

    // Clear the kill switch and RETRY via deployAndSendPreview (replay path).
    p.world.settings.setBool(SETTING_KEYS.outreachKillSwitch, false);
    const retry = await p.deploy.deployAndSendPreview(p.jobId);
    assert.ok(retry.deployed);
    assert.ok(retry.sent, 'retry must report the real send outcome');
    const sentAfter = p.world.email.sent.filter((m) => m.subject === 'Your website preview is ready').length;
    assert.equal(sentAfter, 1, 'link delivered exactly once after retry');
    assert.equal(p.world.jobs.requireById(p.jobId).state, 'AWAITING_CLIENT_APPROVAL');

    // Replay after success: cached, honest, no duplicate email.
    const replay = await p.deploy.deployAndSendPreview(p.jobId);
    assert.ok(replay.deployed && replay.sent);
    assert.equal(p.world.email.sent.filter((m) => m.subject === 'Your website preview is ready').length, 1);
  });

  test('production deploy refusal does not advance state; deploy idempotency on replay', async () => {
    const p = await makeFullPipeline({ paymentConfirmed: true });
    cleanups.push(p.base, p.previews, p.productions);
    await p.drive();
    // Second preview call replays the cached deployment.
    const again = await p.deploy.deployAndSendPreview(p.jobId);
    assert.ok(again.deployed);
    assert.equal(p.world.email.sent.filter((m) => m.subject === 'Your website preview is ready').length, 1, 'no duplicate preview email');
  });
});

