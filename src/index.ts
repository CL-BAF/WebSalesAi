import { loadConfigOrExit } from './config.js';
import { createLogger } from './logger.js';
import { Database } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { AuditEventRepository } from './db/repositories/auditEvents.js';
import { WorkflowJobRepository } from './db/repositories/workflowJobs.js';
import { LeadRepository } from './db/repositories/leads.js';
import { SettingsRepository, SETTING_KEYS } from './db/repositories/settings.js';
import { IdempotencyRepository } from './db/repositories/idempotency.js';
import { AgentRunRepository } from './db/repositories/agentRuns.js';
import { SuppressionRepository } from './db/repositories/suppressions.js';
import { RequirementRepository } from './db/repositories/requirements.js';
import { WebsiteProjectRepository } from './db/repositories/websiteProjects.js';
import { ReviewRepository } from './db/repositories/reviews.js';
import { DeploymentRepository } from './db/repositories/deployments.js';
import { PaymentRepository } from './db/repositories/payments.js';
import { ConversationRepository } from './db/repositories/conversations.js';
import { OutreachRepository } from './db/repositories/outreach.js';
import { WorkflowEngine } from './engine/workflowEngine.js';
import { MockEmailProvider } from './outreach/providers/mockEmail.js';
import { MockPaymentProvider } from './payments/providers/mockPayment.js';
import { LocalDeploymentProvider } from './deploy/providers/localDeploy.js';
import { OutreachService } from './outreach/outreachService.js';
import { ConversationService } from './crm/conversationService.js';
import { ResendEmailProvider } from './outreach/providers/resendEmail.js';
import { ResendInboundService } from './outreach/resendInbound.js';
import { StripePaymentProvider } from './payments/providers/stripePayment.js';
import { CloudflarePagesProvider } from './deploy/providers/cloudflarePages.js';
import type { EmailProvider } from './outreach/emailProvider.js';
import type { PaymentProvider } from './payments/paymentProvider.js';
import type { DeploymentProvider } from './deploy/deploymentProvider.js';
import { LeadService } from './leads/leadService.js';
import { WebsiteBuildService } from './website/buildService.js';
import { BuilderAgent } from './website/builder.js';
import { ReviewService } from './review/reviewService.js';
import { ReviewerAgent } from './review/reviewer.js';
import { DeploymentService } from './deploy/deploymentService.js';
import { PaymentService } from './payments/paymentService.js';
import { SalesAgent } from './crm/salesAgent.js';
import { ResearcherAgent } from './leads/researcher.js';
import { createAgentFramework } from './agents/runtime.js';
import { createHttpServer } from './http/server.js';

export interface AppContext {
  config: ReturnType<typeof loadConfigOrExit>;
  log: ReturnType<typeof createLogger>;
  db: Database;
  audit: AuditEventRepository;
  jobs: WorkflowJobRepository;
  leads: LeadRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
  runs: AgentRunRepository;
  suppressions: SuppressionRepository;
  requirements: RequirementRepository;
  projects: WebsiteProjectRepository;
  reviews: ReviewRepository;
  deployments: DeploymentRepository;
  payments: PaymentRepository;
  conversations: ConversationRepository;
  outreachRepo: OutreachRepository;
  engine: WorkflowEngine;
  email: EmailProvider;
  services: {
    outreach: OutreachService;
    conversations: ConversationService;
    leadService: LeadService;
    buildService: WebsiteBuildService;
    reviewService: ReviewService;
    deploymentService: DeploymentService;
    paymentService: PaymentService;
  };
  resendInbound?: ResendInboundService;
}

export function createAppContext(env: NodeJS.ProcessEnv = process.env): AppContext {
  const config = loadConfigOrExit(env);
  const log = createLogger(config.logLevel);
  const db = new Database(config.databasePath);
  const migrationResult = runMigrations(db);
  log.info(
    { applied: migrationResult.applied, skipped: migrationResult.skipped, database: config.databasePath },
    'database ready',
  );

  const audit = new AuditEventRepository(db);
  const jobs = new WorkflowJobRepository(db);
  const leads = new LeadRepository(db);
  const settings = new SettingsRepository(db);
  const idempotency = new IdempotencyRepository(db);
  const runs = new AgentRunRepository(db);
  const suppressions = new SuppressionRepository(db);
  const requirements = new RequirementRepository(db);
  const projects = new WebsiteProjectRepository(db);
  const reviews = new ReviewRepository(db);
  const deployments = new DeploymentRepository(db);
  const payments = new PaymentRepository(db);
  const conversations = new ConversationRepository(db);
  const outreachRepo = new OutreachRepository(db);
  const engine = new WorkflowEngine(db, jobs, audit);

  // Agents and services — provider selection is config-driven and fail-closed
  // (config.ts refuses real providers without their credentials).
  const framework = createAgentFramework({ config, log, runs, audit } as never);
  const salesAgent = new SalesAgent(framework, { runs, audit, log });

  // Stage 11 readiness gate: real providers are wired ONLY when the master
  // gate is explicitly enabled. Otherwise mocks are wired (fail-safe) with a
  // loud warning. The gate never disables approval/suppression/kill-switch/
  // payment/deploy guards — it only permits configured real providers to run.
  const externalActionsAllowed = config.productionExternalActionsEnabled;
  if (!config.productionExternalActionsEnabled && (config.emailProvider === 'resend' || config.paymentProvider === 'stripe' || config.deploymentProvider === 'cloudflare')) {
    log.warn(
      { PRODUCTION_EXTERNAL_ACTIONS_ENABLED: false },
      'Real provider(s) configured but PRODUCTION_EXTERNAL_ACTIONS_ENABLED=false — MOCK providers will be used for all external actions. Set PRODUCTION_EXTERNAL_ACTIONS_ENABLED=true to permit real side effects.',
    );
  }

  // EMAIL: mock | resend
  let email: EmailProvider = new MockEmailProvider();
    if (config.emailProvider === 'resend' && externalActionsAllowed) {
    email = new ResendEmailProvider({
      apiKey: config.resend.apiKey!,
      from: config.resend.from!,
      senderDomain: config.resend.senderDomain ?? (config.resend.from?.split('@')[1] ?? 'websalesai.local'),
      timeoutMs: config.fetchTimeoutMs,
      retries: config.ollama.transportRetries,
      log,
    });
    log.warn({ mode: 'LIVE' }, 'EMAIL PROVIDER: Resend (LIVE) — outbound email is real. OUTREACH_ENABLED and approval gates still apply.');
    if (!config.outreach.enabled) {
      log.warn({ outreachEnabled: false }, 'Resend is configured but OUTREACH_ENABLED=false — no real email will be sent until outreach is explicitly enabled.');
    }
  }

  // PAYMENT: mock | stripe
  let paymentProvider: PaymentProvider = new MockPaymentProvider();
    if (config.paymentProvider === 'stripe' && externalActionsAllowed) {
    paymentProvider = new StripePaymentProvider({ secretKey: config.stripe.secretKey! });
    const live = config.stripe.secretKey!.startsWith('sk_live_');
    log.warn({ mode: live ? 'LIVE' : 'TEST' }, `PAYMENT PROVIDER: Stripe (${live ? 'LIVE' : 'TEST'}) — checkout sessions are real.`);
  }

  // DEPLOYMENT: local | cloudflare
  let previewProvider: DeploymentProvider = new LocalDeploymentProvider('preview', config.previewsRoot, config.publicBaseUrl);
  let productionProvider: DeploymentProvider = new LocalDeploymentProvider('production', config.productionDeploysRoot, config.publicBaseUrl);
    if (config.deploymentProvider === 'cloudflare' && externalActionsAllowed) {
    const cloudflare = new CloudflarePagesProvider({
      apiToken: config.cloudflare.apiToken!,
      accountId: config.cloudflare.accountId!,
      projectName: config.cloudflare.pagesProject!,
      previewBranch: 'preview',
      workspacesRoot: config.workspacesRoot,
      timeoutMs: 300_000,
    });
    previewProvider = cloudflare;
    productionProvider = cloudflare;
    log.warn({ mode: 'LIVE' }, 'DEPLOYMENT PROVIDER: Cloudflare Pages (LIVE) — deployments publish to the internet.');
  }

  if (config.nodeEnv === 'production' && (config.emailProvider === 'mock' || config.paymentProvider === 'mock' || config.deploymentProvider === 'local')) {
    log.warn({ email: config.emailProvider, payment: config.paymentProvider, deployment: config.deploymentProvider }, 'NODE_ENV=production with mock/local providers — the system will NOT perform real external actions.');
  }

  const outreach = new OutreachService({
    db, leads, jobs, suppressions, conversations, outreach: outreachRepo, settings, idempotency,
    engine, audit, emailProvider: email, salesAgent, config, log,
  });
  const conversationsService = new ConversationService({
    leads, conversations, suppressions, requirements, engine, audit, salesAgent, outreach, log,
  });
  // Inbound email pipeline (Resend) is wired after ConversationService.
    const resendInbound = config.emailProvider === 'resend' && externalActionsAllowed
    ? new ResendInboundService({ config, conversations, conversationService: conversationsService, audit, log })
    : undefined;
  const researcher = new ResearcherAgent(framework);
  const leadService = new LeadService({
    db, leads, suppressions, engine, audit, researcher, config, log,
  });
  const buildService = new WebsiteBuildService({
    config, leads, jobs, requirements, projects, engine, audit, builder: new BuilderAgent(framework), log,
  });
  const reviewService = new ReviewService({
    config, leads, jobs, requirements, reviews, projects, engine, audit, reviewer: new ReviewerAgent(framework), log,
  });
  const paymentService = new PaymentService({
    config, db, jobs, payments, idempotency, engine, audit, paymentProvider, log,
  });
  const deploymentService = new DeploymentService({
    config, db, leads, jobs, projects, deployments, reviews, idempotency, engine, audit,
    previewProvider, productionProvider, isPaymentConfirmed: (jobId) => payments.isPaid(jobId),
    outreach, log,
  });

  // Seed runtime safety switches from env (runtime changes go through settings).
  if (settings.get(SETTING_KEYS.outreachKillSwitch) === undefined) {
    settings.setBool(SETTING_KEYS.outreachKillSwitch, config.outreach.killSwitchInitial);
  }
  if (settings.get(SETTING_KEYS.automationPaused) === undefined) {
    settings.setBool(SETTING_KEYS.automationPaused, config.automationPausedInitial);
  }

  return {
    config, log, db, audit, jobs, leads, settings, idempotency, runs, suppressions,
    requirements, projects, reviews, deployments, payments, conversations, outreachRepo, engine,
    email,
    services: {
      outreach, conversations: conversationsService, leadService, buildService, reviewService, deploymentService, paymentService,
    },
    resendInbound,
  };
}

export function closeAppContext(ctx: AppContext): void {
  ctx.db.close();
}

/** Boots the HTTP dashboard (composition root entrypoint). */
export function startServer(ctx: AppContext, opts: { port?: number } = {}): { ready: Promise<number>; close: () => void } {
  const app = createHttpServer({
    config: ctx.config,
    ctx,
    leadService: ctx.services.leadService,
    outreach: ctx.services.outreach,
    conversations: ctx.services.conversations,
    buildService: ctx.services.buildService,
    reviewService: ctx.services.reviewService,
    deploymentService: ctx.services.deploymentService,
    paymentService: ctx.services.paymentService,
    resendInbound: ctx.resendInbound,
  });
  const desiredPort = opts.port ?? ctx.config.port;
  const server = app.listen(desiredPort);
  const ready = new Promise<number>((resolve, reject) => {
    server.once('listening', () => {
      const address = server.address();
      const actualPort = typeof address === 'object' && address !== null ? address.port : desiredPort;
      ctx.log.info({ port: actualPort, nodeEnv: ctx.config.nodeEnv }, 'WebSalesAi dashboard listening');
      resolve(actualPort);
    });
    server.once('error', reject);
  });
  return {
    ready,
    close: () => server.close(),
  };
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');

if (isDirectRun) {
  const ctx = createAppContext();
  void startServer(ctx);
}



