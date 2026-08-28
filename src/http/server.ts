import express, { type Express, type Request, type Response } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { ValidationError, AppError } from '../domain/errors.js';
import { isInsideDir } from '../website/exec.js';
import {
  issueSession,
  clearSession,
  issueCsrfToken,
  requireSession,
  sessionMiddleware,
  csrfMiddleware,
  verifyPassword,
  type SessionConfig,
} from './session.js';
import { RateLimiter, rateLimitMiddleware } from './rateLimit.js';
import type { AppContext } from '../index.js';
import type { LeadService } from '../leads/leadService.js';
import type { OutreachService } from '../outreach/outreachService.js';
import type { ConversationService } from '../crm/conversationService.js';
import type { WebsiteBuildService } from '../website/buildService.js';
import type { ReviewService } from '../review/reviewService.js';
import type { DeploymentService } from '../deploy/deploymentService.js';
import type { PaymentService } from '../payments/paymentService.js';
import type { AppConfig } from '../config.js';

export interface HttpDeps {
  config: AppConfig;
  ctx: AppContext;
  leadService: LeadService;
  outreach: OutreachService;
  conversations: ConversationService;
  buildService: WebsiteBuildService;
  reviewService: ReviewService;
  deploymentService: DeploymentService;
  paymentService: PaymentService;
}

type Req = Request & { sessionValid?: boolean };

function asyncHandler(fn: (req: Req, res: Response) => Promise<unknown> | unknown) {
  return (req: Req, res: Response, next: express.NextFunction): void => {
    void Promise.resolve(fn(req, res)).catch(next);
  };
}

function paramId(req: Req): string {
  const v = (req.params as Record<string, unknown>)['id'];
  return Array.isArray(v) ? String(v[0] ?? '') : String(v ?? '');
}

function errorStatus(err: unknown): number {
  if (err instanceof AppError) {
    if (err.code === 'NOT_FOUND') return 404;
    if (err.code === 'CONFLICT' || err.code === 'IDEMPOTENCY_IN_FLIGHT' || err.code === 'EXTERNAL_ACTION_ERROR') return 409;
    if (err.code === 'VALIDATION_ERROR' || err.code === 'INVALID_TRANSITION') return 400;
    if (err.code === 'INJECTION_GUARD') return 400;
    return 500;
  }
  return 500;
}

/** Dashboard bucket definitions for the summary endpoint. */
const SUMMARY_BUCKETS: Array<{ label: string; states: string[] }> = [
  { label: 'totalLeads', states: ['LEAD_DISCOVERED', 'RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'REVISION_REQUIRED', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED', 'AWAITING_PAYMENT', 'PAYMENT_CONFIRMED', 'READY_FOR_PRODUCTION', 'DEPLOYING'] },
  { label: 'qualifiedLeads', states: ['READY_FOR_OUTREACH'] },
  { label: 'outreachAwaitingApproval', states: ['AWAITING_OUTREACH_APPROVAL'] },
  { label: 'sentOutreach', states: ['OUTREACH_SENT', 'AWAITING_REPLY'] },
  { label: 'replies', states: ['CONVERSATION_ACTIVE'] },
  { label: 'interested', states: ['INTERESTED'] },
  { label: 'requirementsPending', states: ['REQUIREMENTS_PENDING'] },
  { label: 'websitesBuilding', states: ['READY_TO_BUILD', 'BUILDING', 'REVISION_REQUIRED'] },
  { label: 'websitesUnderReview', states: ['REVIEWING'] },
  { label: 'previewsAwaitingApproval', states: ['PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL'] },
  { label: 'awaitingPayment', states: ['CLIENT_APPROVED', 'AWAITING_PAYMENT'] },
  { label: 'paid', states: ['PAYMENT_CONFIRMED', 'READY_FOR_PRODUCTION'] },
  { label: 'completedJobs', states: ['COMPLETED'] },
  { label: 'failedOrHumanReview', states: ['FAILED', 'NEEDS_HUMAN_REVIEW'] },
  { label: 'rejected', states: ['LEAD_REJECTED', 'OPTED_OUT'] },
];

export function createHttpServer(deps: HttpDeps): Express {
  const app = express();
  const cfg = deps.config;
  const sessionCfg: SessionConfig = { sessionSecret: cfg.sessionSecret, dashboardPassword: cfg.dashboardPassword };
  const loginLimiter = new RateLimiter(10, 15 * 60_000);
  const apiLimiter = new RateLimiter(600, 60_000);
  const webhookLimiter = new RateLimiter(120, 60_000);

  app.disable('x-powered-by');
  app.set('trust proxy', false);

  // Webhooks first: raw bodies for signature verification, no session/CSRF.
  app.post('/webhooks/payment', express.raw({ type: '*/*', limit: '1mb' }), rateLimitMiddleware(webhookLimiter, 'whpay'), asyncHandler(async (req, res) => {
    const signature = String(req.headers[deps.paymentService.signatureHeader] ?? '');
    const result = await deps.paymentService.handleWebhook(req.body.toString('utf8'), signature);
    if (result.handled || result.code === 'duplicate_event') return res.status(200).json(result);
    if (result.code === 'invalid_signature') return res.status(401).json(result);
    if (result.code === 'not_configured') return res.status(503).json(result);
    if (result.code === 'unknown_reference') return res.status(200).json(result);
    res.status(400).json(result);
  }));

  app.post('/webhooks/email', express.raw({ type: '*/*', limit: '2mb' }), rateLimitMiddleware(webhookLimiter, 'whmail'), asyncHandler(async (req, res) => {
    const secret = cfg.inboundEmailWebhookSecret;
    if (!secret) {
      return res.status(503).json({ error: 'inbound email webhook not configured' });
    }
    const signature = String(req.headers['x-inbound-signature'] ?? '');
    const raw = req.body.toString('utf8');
    const expected = createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(signature, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      deps.ctx.audit.append({ actor: 'provider', actorType: 'provider', action: 'webhook.rejected', details: { reason: 'invalid inbound email signature' } });
      return res.status(401).json({ error: 'invalid signature' });
    }
    let parsed: { from?: unknown; subject?: unknown; body?: unknown; externalId?: unknown; provider?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      return res.status(400).json({ error: 'invalid JSON' });
    }
    if (typeof parsed.from !== 'string' || typeof parsed.body !== 'string') {
      return res.status(400).json({ error: 'from and body are required' });
    }
    const result = await deps.conversations.recordInboundReply({
      fromEmail: parsed.from,
      subject: typeof parsed.subject === 'string' ? parsed.subject : undefined,
      body: parsed.body,
      externalId: typeof parsed.externalId === 'string' ? parsed.externalId : undefined,
      provider: typeof parsed.provider === 'string' ? parsed.provider : 'inbound-webhook',
    });
    if (result.outcome === 'unknown_sender' || result.outcome === 'failed') {
      return res.status(422).json(result);
    }
    res.status(200).json(result);
  }));

  // JSON API + dashboard statics.
  app.use(express.json({ limit: '1mb' }));
  app.use(sessionMiddleware(sessionCfg));

  app.post('/login', rateLimitMiddleware(loginLimiter, 'login'), (req: Req, res) => {
    if (!verifyPassword(req, sessionCfg)) {
      return res.status(401).json({ error: 'invalid credentials' });
    }
    issueSession(res, sessionCfg);
    const token = issueCsrfToken(res);
    res.json({ ok: true, csrfToken: token });
  });

  app.post('/logout', (req, res) => {
    clearSession(res);
    res.json({ ok: true });
  });

  // Everything below requires a session.
  app.use('/api', requireSession, rateLimitMiddleware(apiLimiter, 'api'));

  app.get('/api/csrf', (req: Req, res) => {
    res.json({ csrfToken: issueCsrfToken(res) });
  });

  // Mutations require the CSRF header (double-submit cookie).
  const mutating = express.Router();
  mutating.use(csrfMiddleware);

  app.get('/api/summary', asyncHandler(async (_req, res) => {
    const all = deps.ctx.jobs.listAll(10_000);
    const counts: Record<string, number> = {};
    for (const job of all) {
      counts[job.state] = (counts[job.state] ?? 0) + 1;
    }
    const summary: Record<string, number> = {};
    for (const bucket of SUMMARY_BUCKETS) {
      summary[bucket.label] = bucket.states.reduce((acc, s) => acc + (counts[s] ?? 0), 0);
    }
    const settings = {
      killSwitch: deps.ctx.settings.getBool('outreach.kill_switch', cfg.outreach.killSwitchInitial),
      automationPaused: deps.ctx.settings.getBool('automation.paused', cfg.automationPausedInitial),
    };
    res.json({ summary, counts, settings, outreachEnabled: cfg.outreach.enabled });
  }));

  app.get('/api/jobs', asyncHandler(async (req: Req, res) => {
    const state = typeof req.query['state'] === 'string' ? req.query['state'] : undefined;
    const jobs = state ? deps.ctx.jobs.listByStates([state as never]) : deps.ctx.jobs.listAll(500);
    const rows = jobs.map((job) => {
      const lead = deps.ctx.leads.tryGetById(job.leadId);
      const business = lead ? deps.ctx.leads.requireBusiness(lead.businessId) : undefined;
      return {
        jobId: job.id,
        leadId: job.leadId,
        state: job.state,
        revisionCycles: job.revisionCycles,
        businessName: business?.name ?? null,
        websiteUrl: lead?.websiteUrl ?? null,
        contactEmail: lead?.contactEmail ?? null,
        score: lead?.score ?? null,
        updatedAt: job.updatedAt,
      };
    });
    res.json({ jobs: rows });
  }));

  app.get('/api/jobs/:id', asyncHandler(async (req: Req, res) => {
    const job = deps.ctx.jobs.tryGetById(paramId(req));
    if (!job) return res.status(404).json({ error: 'job not found' });
    const lead = deps.ctx.leads.requireLead(job.leadId);
    const business = deps.ctx.leads.requireBusiness(lead.businessId);
    const conversation = deps.ctx.conversations.tryGetByLeadAndChannel(lead.id, 'email');
    const messages = conversation ? deps.ctx.conversations.listMessages(conversation.id) : [];
    const requirements = deps.ctx.requirements.listByJob(job.id);
    const reviews = deps.ctx.reviews.listByJob(job.id);
    const deployments = deps.ctx.deployments.listByJob(job.id);
    const payment = deps.ctx.payments.tryGetLatestForJob(job.id);
    const agentRuns = deps.ctx.runs.listByJob(job.id);
    const draft = deps.ctx.outreachRepo.tryGetLatestDraftForJob(job.id);
    res.json({
      job,
      business,
      lead: { ...lead, dossier: lead.dossierJson ? JSON.parse(lead.dossierJson) : null },
      conversation: conversation ? { id: conversation.id, status: conversation.status } : null,
      messages: messages.map((m) => ({ id: m.id, direction: m.direction, sender: m.sender, subject: m.subject, bodyText: m.bodyText, createdAt: m.createdAt })),
      requirements,
      reviews: reviews.map((r) => ({ cycle: r.cycle, verdict: r.verdict, findings: r.findingsJson ? JSON.parse(r.findingsJson) : null, createdAt: r.createdAt })),
      deployments,
      payment: payment ? { tier: payment.tier, amountCents: payment.amountCents, currency: payment.currency, status: payment.status, checkoutUrl: payment.checkoutUrl } : null,
      agentRuns: agentRuns.map((r) => ({ id: r.id, role: r.role, model: r.model, purpose: r.purpose, attempt: r.attempt, status: r.status, startedAt: r.startedAt, error: r.error })),
      latestDraft: draft,
      audit: deps.ctx.audit.listForJob(job.id),
    });
  }));

  mutating.post('/leads/import', asyncHandler(async (req: Req, res) => {
    const b = req.body as Record<string, unknown>;
    const result = deps.leadService.importLead({
      businessName: String(b['businessName'] ?? ''),
      industry: typeof b['industry'] === 'string' ? b['industry'] : undefined,
      description: typeof b['description'] === 'string' ? b['description'] : undefined,
      source: String(b['source'] ?? 'dashboard'),
      websiteUrl: typeof b['websiteUrl'] === 'string' ? b['websiteUrl'] : undefined,
      contactName: typeof b['contactName'] === 'string' ? b['contactName'] : undefined,
      contactEmail: typeof b['contactEmail'] === 'string' ? b['contactEmail'] : undefined,
      contactSource: typeof b['contactSource'] === 'string' ? b['contactSource'] : 'dashboard',
      discoveryDetail: typeof b['discoveryDetail'] === 'string' ? b['discoveryDetail'] : undefined,
      selectionReason: String(b['selectionReason'] ?? 'manual import via dashboard'),
    }, 'owner');
    res.json(result);
  }));

  mutating.post('/leads/:id/research', asyncHandler(async (req: Req, res) => {
    const result = await deps.leadService.researchLead(paramId(req), { actor: 'owner', actorType: 'owner' });
    res.json(result);
  }));

  mutating.post('/leads/:id/opt-out', asyncHandler(async (req: Req, res) => {
    const lead = deps.ctx.leads.requireLead(paramId(req));
    const result = deps.ctx.engine.transitionLead(lead.id, 'OPTED_OUT', { actor: 'owner', actorType: 'owner', reason: 'owner-initiated opt-out' });
    res.json({ jobId: result.job.id, state: result.job.state });
  }));

  mutating.post('/jobs/:id/draft-outreach', asyncHandler(async (req: Req, res) => {
    const result = await deps.outreach.draftOutreach(paramId(req), { actor: 'owner', actorType: 'owner' });
    res.json(result);
  }));

  mutating.post('/jobs/:id/research', asyncHandler(async (req: Req, res) => {
    const job = deps.ctx.jobs.requireById(paramId(req));
    res.json(await deps.leadService.researchLead(job.leadId, { actor: 'owner', actorType: 'owner' }));
  }));

  mutating.post('/jobs/:id/build', asyncHandler(async (req: Req, res) => {
    const job = deps.ctx.jobs.requireById(paramId(req));
    const revisionCycle = job.state === 'REVISION_REQUIRED' ? job.revisionCycles : 0;
    const result = await deps.buildService.buildForJob(job.id, { revisionCycle, revisionFeedback: ['Owner-requested revision via dashboard'] });
    res.json({ jobId: job.id, commitHash: result.commitHash, files: result.filesWritten.length, checks: result.checks.findings.length });
  }));

  mutating.post('/outreach/drafts/:id/approve', asyncHandler(async (req: Req, res) => {
    res.json(await deps.outreach.approveDraft(paramId(req), 'owner'));
  }));

  mutating.post('/outreach/drafts/:id/reject', asyncHandler(async (req: Req, res) => {
    res.json(deps.outreach.rejectDraft(paramId(req), 'owner'));
  }));

  mutating.post('/jobs/:id/review', asyncHandler(async (req: Req, res) => {
    res.json(await deps.reviewService.reviewSite(paramId(req)));
  }));

  mutating.post('/jobs/:id/deploy-preview', asyncHandler(async (req: Req, res) => {
    res.json(await deps.deploymentService.deployAndSendPreview(paramId(req)));
  }));

  mutating.post('/jobs/:id/deploy-production', asyncHandler(async (req: Req, res) => {
    res.json(await deps.deploymentService.deployProduction(paramId(req)));
  }));

  mutating.post('/jobs/:id/payment-request', asyncHandler(async (req: Req, res) => {
    const tier = String((req.body as Record<string, unknown>)?.['tier'] ?? '');
    res.json(await deps.paymentService.createPaymentRequest(paramId(req), tier));
  }));

  mutating.post('/jobs/:id/transition', asyncHandler(async (req: Req, res) => {
    const b = req.body as Record<string, unknown>;
    const to = String(b['to'] ?? '');
    const reason = typeof b['reason'] === 'string' ? b['reason'] : 'owner transition via dashboard';
    const result = deps.ctx.engine.transition(paramId(req), to as never, { actor: 'owner', actorType: 'owner', reason });
    res.json({ jobId: result.job.id, from: result.from, to: result.to });
  }));

  mutating.post('/jobs/:id/retry', asyncHandler(async (req: Req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    const job = deps.ctx.jobs.requireById(paramId(req));
    deps.ctx.audit.append({ actor: 'owner', actorType: 'owner', action: 'stage.retried', jobId: job.id, details: { note: 'owner retry requested', target: String(b['stage'] ?? 'unspecified') } });
    res.json({ ok: true, note: 'retry dispatched; run the corresponding stage endpoint' });
  }));

  app.use('/api', mutating);

  app.post('/api/settings', requireSession, csrfMiddleware, asyncHandler(async (req: Req, res) => {
    const b = (req.body ?? {}) as Record<string, unknown>;
    if (typeof b['killSwitch'] === 'boolean') {
      deps.ctx.settings.setBool('outreach.kill_switch', b['killSwitch']);
      deps.ctx.audit.append({ actor: 'owner', actorType: 'owner', action: 'kill_switch.changed', details: { enabled: b['killSwitch'] } });
    }
    if (typeof b['paused'] === 'boolean') {
      deps.ctx.settings.setBool('automation.paused', b['paused']);
      deps.ctx.audit.append({ actor: 'owner', actorType: 'owner', action: b['paused'] ? 'automation.paused' : 'automation.resumed', details: {} });
    }
    res.json({ ok: true });
  }));

  // Static preview/production file serving with strict containment.
  const serveStaticDir = (mount: string, rootDir: string) => {
    app.use([`/${mount}`, `/${mount}/:jobId`], (req: Req, res: Response, next: express.NextFunction) => {
      void (async (): Promise<unknown> => {
        const urlPath = req.path.replace(/^\/+/, '');
        const jobId = urlPath.split('/')[0] ?? '';
        if (!/^job_[0-9a-f-]+$/.test(jobId)) return next();
        const rel = urlPath.slice(jobId.length).replace(/^\/+/, '') || 'index.html';
        const root = path.resolve(rootDir, jobId);
        const target = path.resolve(root, rel);
        if (!isInsideDir(root, target)) return res.status(403).end();
        if (!existsSync(target)) return res.status(404).end();
        const content = await readFile(target);
        return res.type(path.extname(target) || 'text/plain').send(content);
      })().catch(next);
    });
  };
  serveStaticDir('preview', cfg.previewsRoot);
  serveStaticDir('production', cfg.productionDeploysRoot);

  // Dashboard static files.
  const publicDir = path.resolve(process.cwd(), 'public');
  app.use(express.static(publicDir, { index: 'index.html' }));

  // Error handler.
  app.use((err: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    const status = errorStatus(err);
    const message = err instanceof Error ? err.message : 'internal error';
    if (status >= 500) {
      deps.ctx.log.error({ err: message }, 'unhandled request error');
    }
    res.status(status).json({ error: message });
  });

  void ValidationError;
  return app;
}



