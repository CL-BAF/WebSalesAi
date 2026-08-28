import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../src/logger.js';
import { makeWorld, seedQualifiedLead, type World } from './helpers/world.js';
import { WebsiteBuildService } from '../src/website/buildService.js';
import { BuilderAgent } from '../src/website/builder.js';
import { runBuildChecks } from '../src/website/checks.js';
import { ValidationError } from '../src/domain/errors.js';
import type { OllamaTransport } from '../src/agents/ollamaClient.js';

const log = createLogger('error');

function sitePayload(): Record<string, unknown> {
  return {
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
    buildNotes: 'Static two-page site',
  };
}

function builderTransport(payload: Record<string, unknown>): OllamaTransport {
  return async (req) => {
    const isBuilder = req.messages.some((m) => m.content.includes('Generate a complete, production-quality STATIC website'));
    if (isBuilder) {
      return { model: req.model, content: JSON.stringify(payload), usage: {} };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
}

function seedRequirements(world: World, jobId: string): void {
  world.requirements.add({ jobId, category: 'pages', title: 'Home page', detail: 'Welcome page with navigation to menu', source: 'customer_reply' });
  world.requirements.add({ jobId, category: 'pages', title: 'Menu page', detail: 'A page showing the full menu', source: 'customer_reply' });
}

function toReadyToBuild(world: World, jobId: string): void {
  // seedQualifiedLead already left the job at READY_FOR_OUTREACH.
  for (const state of ['AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD'] as const) {
    world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }
}

function makeBuildService(base: string, world: World): WebsiteBuildService {
  return new WebsiteBuildService({
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
}

describe('website build service', () => {
  let base: string;
  let world: World;
  let leadId: string;
  let jobId: string;
  let service: WebsiteBuildService;

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), 'wsa-build-'));
    world = makeWorld({
      configOverrides: {
        OUTREACH_ENABLED: 'true',
        WORKSPACES_ROOT: base,
      },
      transport: builderTransport(sitePayload()),
    });
    ({ leadId, jobId } = seedQualifiedLead(world));
    seedRequirements(world, jobId);
    toReadyToBuild(world, jobId);
    service = makeBuildService(base, world);
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test('refuses to build from the wrong state', async () => {
    // Job is at LEAD_DISCOVERED in a fresh world.
    const fresh = makeWorld({ configOverrides: { WORKSPACES_ROOT: base }, transport: builderTransport(sitePayload()) });
    const seed = seedQualifiedLead(fresh);
    seedRequirements(fresh, seed.jobId);
    const freshService = makeBuildService(base, fresh);
    await assert.rejects(() => freshService.buildForJob(seed.jobId), /READY_TO_BUILD/);
    void leadId;
  });

  test('refuses to build with no requirements', async () => {
    const noReq = makeWorld({ configOverrides: { WORKSPACES_ROOT: base }, transport: builderTransport(sitePayload()) });
    const seed = seedQualifiedLead(noReq);
    toReadyToBuild(noReq, seed.jobId);
    const noReqService = makeBuildService(base, noReq);
    await assert.rejects(() => noReqService.buildForJob(seed.jobId), /no requirements/);
    void jobId;
  });

  test('full build: writes files, commits, transitions BUILDING→REVIEWING', async () => {
    const result = await service.buildForJob(jobId);
    assert.equal(result.filesWritten.length, 3);
    assert.ok(existsSync(path.join(base, jobId, 'index.html')));
    assert.ok(existsSync(path.join(base, jobId, 'css', 'site.css')));
    assert.ok(result.commitHash && /^[0-9a-f]{7,40}$/.test(result.commitHash));
    assert.equal(world.jobs.requireById(jobId).state, 'REVIEWING');
    const project = world.projects.requireByJobId(jobId);
    assert.equal(project.workspacePath, path.resolve(base, jobId));
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'generation.started'));
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'files.generated'));
    assert.ok(world.audit.listForJob(jobId).some((e) => e.action === 'generation.completed'));
    // No check findings on the clean fixture.
    assert.equal(result.checks.findings.length, 0);
    // Second build from REVIEWING is refused (must go through revision path).
    await assert.rejects(() => service.buildForJob(jobId), ValidationError);
  });

  test('revision build requires REVISION_REQUIRED state', async () => {
    await service.buildForJob(jobId); // now REVIEWING
    // Owner moves REVIEWING → REVISION_REQUIRED; revision build is legal.
    world.engine.transition(jobId, 'REVISION_REQUIRED', { actor: 'system', actorType: 'system', reason: 'test revision' });
    const result = await service.buildForJob(jobId, { revisionCycle: 1, revisionFeedback: ['Fix contrast'] });
    assert.equal(result.project.status, 'revision_required');
    assert.equal(world.jobs.requireById(jobId).state, 'REVIEWING');
    const revisionTask = world.db.get<{ input_json: string }>("SELECT input_json FROM agent_runs WHERE role = 'builder' ORDER BY started_at DESC LIMIT 1");
    void revisionTask;
    assert.equal(world.jobs.getRevisionCycles(jobId), 0); // incremented by reviewer stage, not builder
  });

  test('deterministic checks flag broken sites', () => {
    const files = new Map<string, string>([
      ['index.html', '<html><body><a href="missing.html">x</a><img src="x.png"><p>Lorem ipsum</p></body></html>'],
    ]);
    const res = runBuildChecks(files);
    const categories = res.findings.map((f) => f.category);
    assert.ok(categories.includes('links'));
    assert.ok(categories.includes('accessibility'));
    assert.ok(categories.includes('placeholder_content'));
    assert.ok(categories.includes('seo'));
    assert.ok(categories.includes('responsive'));
    // Secrets scanner on non-HTML files (needs an HTML page to pass the gate)
    const secretScan = runBuildChecks(new Map<string, string>([
      ['index.html', '<html><head><title>t</title><meta name="viewport" content="w"></head><body>ok</body></html>'],
      ['config.js', 'const apiKey = "sk-abcdefghijklmnop123456";'],
    ]));
    assert.ok(secretScan.findings.some((f) => f.category === 'exposed_secrets'));
  });
});
