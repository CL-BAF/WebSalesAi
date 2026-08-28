import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';
import { ReviewRepository } from '../src/db/repositories/reviews.js';
import { makeWorld, seedQualifiedLead, type World } from './helpers/world.js';
import { WebsiteBuildService } from '../src/website/buildService.js';
import { BuilderAgent } from '../src/website/builder.js';
import { ReviewService } from '../src/review/reviewService.js';
import { ReviewerAgent } from '../src/review/reviewer.js';
import type { OllamaTransport, OllamaChatRequest, OllamaChatResult } from '../src/agents/ollamaClient.js';

const log = createLogger('error');

const GOOD_SITE = {
  siteTitle: 'Acme Bakery',
  pages: [
    { path: 'index.html', title: 'Home' },
    { path: 'menu.html', title: 'Menu' },
  ],
  files: [
    {
      path: 'index.html',
      content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Acme Bakery</title><meta name="description" content="Acme Bakery website"><link rel="stylesheet" href="css/site.css"></head><body><header><nav><a href="index.html">Home</a> <a href="menu.html">Menu</a></nav></header><main><h1>Welcome to Acme Bakery</h1><p>A page showing the full menu of our bakery.</p></main><footer><p>&copy; Acme Bakery</p></footer></body></html>`,
    },
    {
      path: 'menu.html',
      content: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Menu — Acme Bakery</title><meta name="description" content="Menu page"><link rel="stylesheet" href="css/site.css"></head><body><h1>Menu</h1><p>Menu details from requirements.</p><p><a href="index.html">Back home</a></p></body></html>`,
    },
    { path: 'css/site.css', content: 'body{font-family:sans-serif;margin:0}main{padding:1rem}' },
  ],
  buildNotes: 'clean',
};

function reviewVerdictPayload(verdict: 'PASS' | 'CHANGES_REQUIRED', findings: unknown[] = []): Record<string, unknown> {
  return {
    verdict,
    summary: verdict === 'PASS' ? 'Requirements covered; no high-severity issues.' : 'Requirements not fully covered.',
    findings,
  };
}

function makeQaTransport(opts: { builderPayload?: typeof GOOD_SITE; reviewFails?: boolean; reviewVerdict?: 'PASS' | 'CHANGES_REQUIRED'; reviewFindings?: unknown[] }): OllamaTransport {
  return async (req: OllamaChatRequest): Promise<OllamaChatResult> => {
    if (req.messages.some((m) => m.content.includes('Generate a complete, production-quality STATIC website'))) {
      return { model: req.model, content: JSON.stringify(opts.builderPayload ?? GOOD_SITE), usage: {} };
    }
    if (req.messages.some((m) => m.content.includes('Evaluate the generated website INDEPENDENTLY'))) {
      if (opts.reviewFails) throw new Error('reviewer transport down');
      return { model: req.model, content: JSON.stringify(reviewVerdictPayload(opts.reviewVerdict ?? 'PASS', opts.reviewFindings)), usage: {} };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
}

interface QaWorld {
  world: World;
  base: string;
  build: WebsiteBuildService;
  review: ReviewService;
}

function makeQaWorld(transportOpts: Parameters<typeof makeQaTransport>[0], configOverrides: Record<string, string> = {}): QaWorld {
  const base = mkdtempSync(path.join(tmpdir(), 'wsa-qa-'));
  const world = makeWorld({ configOverrides: { ...configOverrides, WORKSPACES_ROOT: base }, transport: makeQaTransport(transportOpts) });
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
  return { world, base, build, review };
}

describe('review QA loop', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function seedToReviewing(world: World): { jobId: string } {
    const { jobId } = seedQualifiedLead(world);
    world.requirements.add({ jobId, category: 'pages', title: 'Home page', detail: 'Welcome page', source: 'customer_reply' });
    world.requirements.add({ jobId, category: 'pages', title: 'Menu page', detail: 'A page showing the full menu', source: 'customer_reply' });
    for (const state of ['AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD'] as const) {
      world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
    }
    return { jobId };
  }

  test('PASS path: REVIEWING → PREVIEW_READY with recorded review', async () => {
    const { world, base, build, review } = makeQaWorld({ reviewVerdict: 'PASS' });
    cleanups.push(base);
    const { jobId } = seedToReviewing(world);
    await build.buildForJob(jobId);
    const outcome = await review.reviewSite(jobId);
    assert.equal(outcome.outcome, 'passed');
    if (outcome.outcome === 'passed') {
      assert.equal(outcome.jobState, 'PREVIEW_READY');
      assert.equal(outcome.review.cycle, 1);
    }
    assert.equal(world.jobs.requireById(jobId).state, 'PREVIEW_READY');
    assert.equal(world.jobs.requireById(jobId).revisionCycles, 0);
  });

  test('CHANGES_REQUIRED under limit → REVISION_REQUIRED, cycles increment, revision build returns to REVIEWING', async () => {
    const { world, base, build, review } = makeQaWorld({
      reviewVerdict: 'CHANGES_REQUIRED',
      reviewFindings: [{ category: 'requirements_coverage', severity: 'medium', description: 'Menu page lacks detail' }],
    });
    cleanups.push(base);
    const { jobId } = seedToReviewing(world);
    await build.buildForJob(jobId);
    const outcome1 = await review.reviewSite(jobId);
    assert.equal(outcome1.outcome, 'revision_required');
    assert.equal(world.jobs.requireById(jobId).state, 'REVISION_REQUIRED');
    assert.equal(world.jobs.getRevisionCycles(jobId), 1);

    const result = await build.buildForJob(jobId, { revisionCycle: 1, revisionFeedback: ['Add menu detail'] });
    assert.equal(world.jobs.requireById(jobId).state, 'REVIEWING');
    assert.ok(result.commitHash);

    const outcome2 = await review.reviewSite(jobId, { revisionCycle: 1 });
    assert.equal(outcome2.outcome, 'revision_required');
    assert.equal(outcome2.review.cycle, 2);
  });

  test('revision cycle limit exhausted → NEEDS_HUMAN_REVIEW', async () => {
    const { world, base, build, review } = makeQaWorld(
      {
        reviewVerdict: 'CHANGES_REQUIRED',
        reviewFindings: [{ category: 'requirements_coverage', severity: 'medium', description: 'Still not covered' }],
      },
      { REVIEW_MAX_CYCLES: '2' },
    );
    cleanups.push(base);
    const { jobId } = seedToReviewing(world);
    await build.buildForJob(jobId);

    const o1 = await review.reviewSite(jobId);
    assert.equal(o1.outcome, 'revision_required');
    await build.buildForJob(jobId, { revisionCycle: 1, revisionFeedback: ['x'] });
    const o2 = await review.reviewSite(jobId, { revisionCycle: 1 });
    assert.equal(o2.outcome, 'revision_required');
    await build.buildForJob(jobId, { revisionCycle: 2, revisionFeedback: ['x'] });
    const o3 = await review.reviewSite(jobId, { revisionCycle: 2 });
    assert.equal(o3.outcome, 'human_review');
    assert.equal(world.jobs.requireById(jobId).state, 'NEEDS_HUMAN_REVIEW');
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'human_review.requested'));
  });

  test('deterministic HIGH findings overrule a model PASS', async () => {
    const brokenSite = {
      ...GOOD_SITE,
      files: [...GOOD_SITE.files, { path: 'broken.html', content: '<html><body><a href="ghost.html">dead</a><p>Lorem ipsum</p></body></html>' }],
    };
    const { world, base, build, review } = makeQaWorld({ builderPayload: brokenSite, reviewVerdict: 'PASS' });
    cleanups.push(base);
    const { jobId } = seedToReviewing(world);
    await build.buildForJob(jobId);
    const outcome = await review.reviewSite(jobId);
    assert.equal(outcome.outcome, 'revision_required', 'HIGH deterministic findings must force CHANGES_REQUIRED');
    if (outcome.outcome === 'revision_required') {
      assert.ok(outcome.verdict.findings.some((f) => f.description.includes('deterministic check')));
    }
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'review.failed'));
  });

  test('reviewer transport failure → NEEDS_HUMAN_REVIEW (safe failure)', async () => {
    const { world, base, build, review } = makeQaWorld({ reviewFails: true });
    cleanups.push(base);
    const { jobId } = seedToReviewing(world);
    await build.buildForJob(jobId);
    const outcome = await review.reviewSite(jobId);
    assert.equal(outcome.outcome, 'human_review');
    assert.equal(world.jobs.requireById(jobId).state, 'NEEDS_HUMAN_REVIEW');
  });
});
