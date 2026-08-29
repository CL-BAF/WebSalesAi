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
export async function makeFullPipeline(opts: { reviewVerdict?: 'PASS' | 'CHANGES_REQUIRED'; requirePayment?: string; paymentConfirmed?: boolean } = {}): Promise<FullPipeline> {
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
