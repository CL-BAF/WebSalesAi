import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createLogger } from '../../src/logger.js';
import { ReviewRepository } from '../../src/db/repositories/reviews.js';
import { DeploymentRepository } from '../../src/db/repositories/deployments.js';
import { LocalDeploymentProvider } from '../../src/deploy/providers/localDeploy.js';
import { DeploymentService } from '../../src/deploy/deploymentService.js';
import { makeWorld, seedQualifiedLead, type World } from './world.js';
import { WebsiteBuildService } from '../../src/website/buildService.js';
import { BuilderAgent } from '../../src/website/builder.js';
import { ReviewService } from '../../src/review/reviewService.js';
import { ReviewerAgent } from '../../src/review/reviewer.js';
import { LeadService } from '../../src/leads/leadService.js';
import { ResearcherAgent } from '../../src/leads/researcher.js';
import assert from 'node:assert/strict';
import type { OllamaTransport, OllamaChatRequest, OllamaChatResult } from '../../src/agents/ollamaClient.js';

const log = createLogger('error');

export const GOOD_SITE = {
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

export interface FullPipeline {
  world: World;
  base: string;
  previews: string;
  productions: string;
  build: WebsiteBuildService;
  review: ReviewService;
  deploy: DeploymentService;
  jobId: string;
  leadId: string;
  drive: () => Promise<void>;
}

/**
 * Full pipeline fixture: qualified lead → real outreach send → build →
 * review → preview deploy. Review verdict and payment confirmation are
 * configurable; tests drive remaining state via the engine.
 */
export async function makeFullPipeline(opts: { reviewVerdict?: 'PASS' | 'CHANGES_REQUIRED'; requirePayment?: string; paymentConfirmed?: boolean; researchFirst?: boolean; paymentWebhookSecret?: string } = {}): Promise<FullPipeline> {
  const base = mkdtempSync(path.join(tmpdir(), 'wsa-full-'));
  const previews = mkdtempSync(path.join(tmpdir(), 'wsa-prev-'));
  const productions = mkdtempSync(path.join(tmpdir(), 'wsa-prod-'));
  const transport: OllamaTransport = async (req: OllamaChatRequest): Promise<OllamaChatResult> => {
    // [SIMULATED agent] Researcher produces a qualified dossier when the
    // E2E drives the real research flow (researchFirst: true).
    if (req.messages.some((m) => m.content.includes('Analyse this business lead'))) {
      return {
        model: req.model,
        content: JSON.stringify({
          businessName: 'Sandbox Bakery',
          websitePresent: true,
          summary: 'Bakery with a dated website.',
          verifiedFacts: [{ claim: 'Operates a bakery', source: 'website' }],
          inferredObservations: [],
          identifiedProblems: [{ title: 'No mobile layout', evidence: 'viewport meta missing', severity: 'high' }],
          score: 78,
          confidence: 0.85,
          recommendForOutreach: true,
          rejectionReasons: [],
        }),
        usage: {},
      };
    }
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
    configOverrides: {
      OUTREACH_ENABLED: 'true',
      WORKSPACES_ROOT: base,
      REQUIRE_PAYMENT_FOR_PRODUCTION: opts.requirePayment ?? 'true',
      PAYMENT_WEBHOOK_SECRET: opts.paymentWebhookSecret ?? '',
    },
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
  // Late-bound job id: assigned in the seed section below, read by the
  // payment-confirmation closure at deploy time.
  const jobIdLate: { id: string } = { id: '' };
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
    isPaymentConfirmed: () => opts.paymentConfirmed ?? world.payments.isPaid(jobIdLate.id),
    // Late-bound: jobId is assigned after construction (researchFirst path).
    outreach: world.outreach,
    log,
  });

  // Research-first path (S10 E2E): the REAL research pipeline runs over a
  // synthetic lead — import gates (dedupe/suppression), SSRF-guarded fetch
  // fixture, Researcher agent (simulated), dossier persistence, and the
  // deterministic qualification transition.
  const leadService = new LeadService({
    db: world.db, leads: world.leads, suppressions: world.suppressions,
    engine: world.engine, audit: world.audit, researcher: new ResearcherAgent(world.framework),
    config: world.config, log,
    fetchWebsiteText: async () =>
      '[SIMULATED fetch] Sandbox Bakery — fresh bread, family owned since 1998, open 7 days.',
  });

  let leadId: string;
  let jobId: string;
  if (opts.researchFirst === true) {
    // S10: run the REAL research pipeline — [SIMULATED] website fetch
    // (fetchWebsiteText above) and [SIMULATED agent] (transport above).
    const imported = leadService.importLead({
      businessName: 'Sandbox Bakery',
      source: 'sandbox-e2e',
      websiteUrl: 'https://sandbox-bakery.example.com',
      contactEmail: 'owner@sandboxbakery.example.com',
      contactSource: 'sandbox-fixture',
      discoveryDetail: 'synthetic lead created by the sandbox E2E',
      selectionReason: 'sandbox end-to-end demonstration',
    }, 'owner');
    assert.equal((imported as { outcome: string }).outcome, 'imported', 'sandbox fixture import must succeed');
    if (imported.outcome !== 'imported') throw new Error('sandbox import failed');
    const researched = await leadService.researchLead(imported.lead.id);
    if (researched.outcome !== 'qualified' && researched.outcome !== 'rejected') throw new Error('research failed');
    if (researched.outcome !== 'qualified') throw new Error('sandbox research did not qualify the lead');
    leadId = imported.lead.id;
    jobId = researched.job.id;
  } else {
    const seeded = seedQualifiedLead(world);
    leadId = seeded.leadId;
    jobId = seeded.jobId;
  }
  world.requirements.add({ jobId, category: 'pages', title: 'Home page', detail: 'Welcome page with menu summary', source: 'customer_reply' });
  jobIdLate.id = jobId;
  // Reach READY_TO_BUILD through the REAL outreach path so the email thread
  // exists (the preview link send requires a contacted lead).
  const outreach = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
  const sent = await world.outreach.approveDraft(outreach.draft.id, 'owner');
  if (!sent.sent) throw new Error(`fixture outreach send failed: ${sent.reason}`);
  for (const state of ['CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD'] as const) {
    world.engine.transition(jobId, state, { actor: 'system', actorType: 'system' });
  }

  const drive = async (): Promise<void> => {
    await build.buildForJob(jobId);
    await review.reviewSite(jobId);
    await deploy.deployAndSendPreview(jobId);
  };

  return { world, base, previews, productions, build, review, deploy, jobId, leadId, drive };
}
