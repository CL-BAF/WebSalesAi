import { Database } from '../../src/db/database.js';
import { runMigrations } from '../../src/db/migrations.js';
import { LeadRepository } from '../../src/db/repositories/leads.js';
import { WorkflowJobRepository } from '../../src/db/repositories/workflowJobs.js';
import { SuppressionRepository } from '../../src/db/repositories/suppressions.js';
import { ConversationRepository } from '../../src/db/repositories/conversations.js';
import { OutreachRepository } from '../../src/db/repositories/outreach.js';
import { RequirementRepository } from '../../src/db/repositories/requirements.js';
import { SettingsRepository } from '../../src/db/repositories/settings.js';
import { IdempotencyRepository } from '../../src/db/repositories/idempotency.js';
import { AgentRunRepository } from '../../src/db/repositories/agentRuns.js';
import { AuditEventRepository } from '../../src/db/repositories/auditEvents.js';
import { WebsiteProjectRepository } from '../../src/db/repositories/websiteProjects.js';
import { ReviewRepository } from '../../src/db/repositories/reviews.js';
import { WorkflowEngine } from '../../src/engine/workflowEngine.js';
import { AgentFramework } from '../../src/agents/framework.js';
import { SalesAgent } from '../../src/crm/salesAgent.js';
import { ConversationService } from '../../src/crm/conversationService.js';
import { MockEmailProvider } from '../../src/outreach/providers/mockEmail.js';
import { OutreachService } from '../../src/outreach/outreachService.js';
import { loadConfig, type AppConfig } from '../../src/config.js';
import { createLogger } from '../../src/logger.js';
import type { OllamaTransport } from '../../src/agents/ollamaClient.js';

const log = createLogger('error');

export interface World {
  db: Database;
  leads: LeadRepository;
  jobs: WorkflowJobRepository;
  suppressions: SuppressionRepository;
  conversations: ConversationRepository;
  outreachRepo: OutreachRepository;
  requirements: RequirementRepository;
  projects: WebsiteProjectRepository;
  reviews: ReviewRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
  runs: AgentRunRepository;
  audit: AuditEventRepository;
  engine: WorkflowEngine;
  salesAgent: SalesAgent;
  framework: AgentFramework;
  email: MockEmailProvider;
  outreach: OutreachService;
  conversationsService: ConversationService;
  config: AppConfig;
  now: () => Date;
}

export function makeWorld(opts: {
  configOverrides?: Record<string, string>;
  transport?: OllamaTransport;
  now?: () => Date;
  /** Override the email provider (e.g. the real Resend adapter with fake fetch). */
  emailProvider?: import('../../src/outreach/emailProvider.js').EmailProvider;
} = {}): World {
  const config = loadConfig({ NODE_ENV: 'test', ...opts.configOverrides } as NodeJS.ProcessEnv);
  const db = new Database(':memory:');
  runMigrations(db);
  const leads = new LeadRepository(db);
  const jobs = new WorkflowJobRepository(db);
  const suppressions = new SuppressionRepository(db);
  const conversations = new ConversationRepository(db);
  const outreachRepo = new OutreachRepository(db);
  const requirements = new RequirementRepository(db);
  const projects = new WebsiteProjectRepository(db);
  const reviews = new ReviewRepository(db);
  const settings = new SettingsRepository(db);
  const idempotency = new IdempotencyRepository(db);
  const runs = new AgentRunRepository(db);
  const audit = new AuditEventRepository(db);
  const engine = new WorkflowEngine(db, jobs, audit);
  const framework = new AgentFramework({
    transport:
      opts.transport ??
      (async (req) => ({
        model: req.model,
        content: JSON.stringify({ subject: 'Quick question about the Acme site', body: 'Hi, would a modern redesign help your bakery? â€” WebSalesAi' }),
        usage: {},
      })),
    models: config.ollama.models,
    maxRepairRetries: 1,
    runs,
    audit,
    log,
  });
  const salesAgent = new SalesAgent(framework, { runs, audit, log });
  const email = (opts.emailProvider ?? new MockEmailProvider()) as MockEmailProvider;
  const outreach = new OutreachService({
    db,
    leads,
    jobs,
    suppressions,
    conversations,
    outreach: outreachRepo,
    settings,
    idempotency,
    engine,
    audit,
    emailProvider: email,
    salesAgent,
    config,
    log,
    now: opts.now ?? (() => new Date()),
  });
  const conversationsService = new ConversationService({
    leads,
    conversations,
    suppressions,
    requirements,
    engine,
    audit,
    salesAgent,
    outreach,
    log,
  });
  return {
    db, leads, jobs, suppressions, conversations, outreachRepo, requirements, projects, reviews, settings,
    idempotency, runs, audit, engine, salesAgent, framework, email, outreach,
    conversationsService, config, now: opts.now ?? (() => new Date()),
  };
}

export function seedQualifiedLead(
  world: World,
  opts: { businessName?: string; websiteUrl?: string; contactEmail?: string; selectionReason?: string } = {},
): { leadId: string; jobId: string } {
  const { lead } = world.leads.createLead({
    businessName: opts.businessName ?? 'Acme Bakery',
    source: 'test',
    websiteUrl: opts.websiteUrl ?? 'https://acmebakery.example.com',
    contactEmail: opts.contactEmail ?? 'owner@acmebakery.example.com',
    selectionReason: opts.selectionReason ?? 'test fixture',
  });
  world.leads.updateResearch(lead.id, {
    score: 80,
    confidence: 0.9,
    dossierJson: JSON.stringify({
      businessName: opts.businessName ?? 'Acme Bakery',
      websitePresent: true,
      summary: 'Test dossier.',
      verifiedFacts: [],
      inferredObservations: [],
      identifiedProblems: [],
      score: 80,
      confidence: 0.9,
      recommendForOutreach: true,
      rejectionReasons: [],
    }),
  });
  const job = world.engine.getOrCreateJobForLead(lead.id);
  world.engine.transition(job.id, 'RESEARCHING', { actor: 'system', actorType: 'system' });
  world.engine.transition(job.id, 'READY_FOR_OUTREACH', { actor: 'system', actorType: 'system' });
  return { leadId: lead.id, jobId: job.id };
}

export async function sendFirstOutreach(world: World, leadId: string): Promise<void> {
  const { draft } = await world.outreach.draftOutreach(leadId, { actor: 'agent:sales', actorType: 'agent' });
  const res = await world.outreach.approveDraft(draft.id, 'owner');
  if (!res.sent) throw new Error(`fixture send failed: ${res.reason ?? 'unknown'}`);
}

export function classificationPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    intent: 'question',
    confidence: 0.9,
    summary: 'Customer asked about timeline.',
    extractedRequirements: [],
    suggestedReply: 'Thanks for your question â€” typical timelines are 2-4 weeks once requirements are clear.',
    needsHumanReview: false,
    ...overrides,
  };
}

export function transportFor(payload: Record<string, unknown>): OllamaTransport {
  return async (req) => {
    const isClassify = req.messages.some((m) => m.content.includes('Classify the customer reply'));
    if (isClassify) {
      return { model: req.model, content: JSON.stringify(payload), usage: {} };
    }
    return { model: req.model, content: JSON.stringify({ subject: 'S', body: 'B' }), usage: {} };
  };
}

export function makeWorldWithClassification(payload: Record<string, unknown>, configOverrides: Record<string, string> = { OUTREACH_ENABLED: 'true' }): World {
  return makeWorld({ configOverrides, transport: transportFor(payload) });
}

