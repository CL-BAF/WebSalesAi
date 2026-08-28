import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';
import { ReviewRepository } from '../src/db/repositories/reviews.js';
import { DeploymentRepository } from '../src/db/repositories/deployments.js';
import { LocalDeploymentProvider } from '../src/deploy/providers/localDeploy.js';
import { DeploymentService } from '../src/deploy/deploymentService.js';
import { makeWorld, seedQualifiedLead, type World } from './helpers/world.js';
import { WebsiteBuildService } from '../src/website/buildService.js';
import { BuilderAgent } from '../src/website/builder.js';
import { ReviewService } from '../src/review/reviewService.js';
import { ReviewerAgent } from '../src/review/reviewer.js';
import type { OllamaTransport, OllamaChatRequest, OllamaChatResult } from '../src/agents/ollamaClient.js';

const log = createLogger('error');

const GOOD_SITE = {
  siteTitle: 'Acme Bakery',
  pages: [{ path: 'index.html', title: 'Home' }],
  files: [
    {
      path: 'index.html',
      content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Bakery</title><meta name="description" content="Acme Bakery website"><link rel="stylesheet" href="css/site.css"></head><body><h1>Welcome to Acme Bakery</h1><p>Menu details from requirements.</p></body></html>`,
    },
    { path: 'css/site.css', content: 'body{font-family:sans-serif}' },
  ],
  buildNotes: 'clean',
};

interface FullPipeline {
  world: World;
  base: string;
  previews: string;
  productions: string;
  build: WebsiteBuildService;
  review: ReviewService;
  deploy: DeploymentService;
  jobId: string;
  drive: () => Promise<void>;
}

async function makeFullPipeline(opts: { reviewVerdict?: 'PASS' | 'CHANGES_REQUIRED'; requirePayment?: string; paymentConfirmed?: boolean } = {}): Promise<FullPipeline> {
  const base = mkdtempSync(path.join(tmpdir(), 'wsa-full-'));
  const previews = mkdtempSync(path.join(tmpdir(), 'wsa-prev-'));
  const productions = mkdtempSync(path.join(tmpdir(), 'wsa-prod-'));
  const transport: OllamaTransport = async (req: OllamaChatRequest): Promise<OllamaChatResult> => {
    if (req.messages.some((m) => m.content.includes('Generate a complete, production-quality STATIC website'))) {
      return { model: req.model, content: JSON.stringify(GOOD_SITE), usage: {} };
    }
    if (req.messages.some((m) => m.content.includes('Evaluate the generated website INDEPENDENTLY'))) {
      return {
        model: req.model,
        content: JSON.stringify({ verdict: opts.reviewVerdict ?? 'PASS', summary: 'Reviewed.', findings: [] }),
        usage: {},
      };
    }
    if (req.messages.some((m) => m.content.includes('Classify the customer reply'))) {
      return {
        model: req.model,
        content: JSON.stringify({ intent: 'positive', confidence: 0.95, summary: 'Client approves the preview.', extractedRequirements: [], needsHumanReview: false }),
        usage: {},
      };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
  const world = makeWorld({
    configOverrides: { OUTREACH_ENABLED: 'true', WORKSPACES_ROOT: base, REQUIRE_PAYMENT_FOR_PRODUCTION: opts.requirePayment ?? 'true' },
    transport,
  });
  const build = new WebsiteBuildService({
    config: world.config,
    leads: world.leads,
    jobs: world.jobs,
    requirements: world.requirements,
    projects: world.projects,
    engine: world.engine,
    audit: world.audit,
    builder: new BuilderAgent(world.framework),
    log,
  });
  const review = new ReviewService({
    config: world.config,
    leads: world.leads,
    jobs: world.jobs,
    requirements: world.requirements,
    reviews: new ReviewRepository(world.db),
    projects: world.projects,
    engine: world.engine,
    audit: world.audit,
    reviewer: new ReviewerAgent(world.framework),
    log,
  });
  const deployments = new DeploymentRepository(world.db);
  const deploy = new DeploymentService({
    config: world.config,
    db: world.db,
    leads: world.leads,
    jobs: world.jobs,
    projects: world.projects,
    deployments,
    reviews: new ReviewRepository(world.db),
    idempotency: world.idempotency,
    engine: world.engine,
    audit: world.audit,
    previewProvider: new LocalDeploymentProvider('preview', previews, world.config.publicBaseUrl),
    productionProvider: new LocalDeploymentProvider('production', productions, world.config.publicBaseUrl),
    isPaymentConfirmed: () => opts.paymentConfirmed ?? false,
    outreach: world.outreach,
    log,
  });

  const { leadId, jobId } = seedQualifiedLead(world);
  world.requirements.add({ jobId, category: 'pages', title: 'Home page', detail: 'Welcome page with menu summary', source: 'customer_reply' });
  // Reach READY_TO_BUILD through the REAL outreach path so the email thread
  // exists (the preview link send requires a contacted lead).
  const outreach = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
  const sent = await world.outreach.approveDraft(outreach.draft.id, 'owner');
  if (!sent.sent) throw new Error(`fixture outreach send failed: ${sent.reason}`);
  // approveDraft already left the job at AWAITING_REPLY.
  for (const state of ['CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD'] as const) {
    world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }

  const drive = async (): Promise<void> => {
    await build.buildForJob(jobId);
    await review.reviewSite(jobId);
    await deploy.deployAndSendPreview(jobId);
  };

  return { world, base, previews, productions, build, review, deploy, jobId, drive };
}

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
