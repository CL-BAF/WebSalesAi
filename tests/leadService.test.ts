import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { LeadRepository } from '../src/db/repositories/leads.js';
import { SuppressionRepository } from '../src/db/repositories/suppressions.js';
import { WorkflowJobRepository } from '../src/db/repositories/workflowJobs.js';
import { AuditEventRepository } from '../src/db/repositories/auditEvents.js';
import { AgentRunRepository } from '../src/db/repositories/agentRuns.js';
import { WorkflowEngine } from '../src/engine/workflowEngine.js';
import { AgentFramework } from '../src/agents/framework.js';
import { ResearcherAgent } from '../src/leads/researcher.js';
import { LeadService, type ImportLeadInput } from '../src/leads/leadService.js';
import { researcherDossierSchema } from '../src/agents/schemas.js';
import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';
import { ValidationError } from '../src/domain/errors.js';
import type { OllamaTransport } from '../src/agents/ollamaClient.js';

const log = createLogger('error');
const config = loadConfig({ NODE_ENV: 'test' } as NodeJS.ProcessEnv);

let db: Database;
let leads: LeadRepository;
let suppressions: SuppressionRepository;
let jobs: WorkflowJobRepository;
let audit: AuditEventRepository;
let runs: AgentRunRepository;
let engine: WorkflowEngine;
let service: LeadService;
let transportCalls: Array<{ model: string; task: string }>;

function dossierPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    businessName: 'Test Business',
    websitePresent: true,
    summary: 'A test business.',
    verifiedFacts: [{ claim: 'Has a website', source: 'website' }],
    inferredObservations: [],
    identifiedProblems: [{ title: 'Old design', evidence: 'copyright 2012', severity: 'medium' }],
    score: 75,
    confidence: 0.8,
    recommendForOutreach: true,
    rejectionReasons: [],
    ...overrides,
  };
}

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  leads = new LeadRepository(db);
  suppressions = new SuppressionRepository(db);
  jobs = new WorkflowJobRepository(db);
  audit = new AuditEventRepository(db);
  runs = new AgentRunRepository(db);
  engine = new WorkflowEngine(db, jobs, audit);
  transportCalls = [];
});

afterEach(() => {
  db.close();
});

function makeService(transport?: OllamaTransport, fetchWebsiteText?: (url: string) => Promise<string>): LeadService {
  const fw = new AgentFramework({
    transport:
      transport ??
      (async (req) => {
        transportCalls.push({ model: req.model, task: req.messages.map((m) => m.content).join('\n') });
        return { model: req.model, content: JSON.stringify(dossierPayload()), usage: { promptTokens: 10, responseTokens: 10 } };
      }),
    models: config.ollama.models,
    maxRepairRetries: config.ollama.maxRepairRetries,
    runs,
    audit,
    log,
  });
  return new LeadService({
    db,
    leads,
    suppressions,
    engine,
    audit,
    researcher: new ResearcherAgent(fw),
    config,
    log,
    fetchWebsiteText: fetchWebsiteText ?? (async () => 'SITE CONTENT about the business'),
  });
}

const sampleLead: ImportLeadInput = {
  businessName: 'Acme Bakery',
  source: 'manual-import',
  websiteUrl: 'https://acmebakery.example.com',
  contactEmail: 'info@acmebakery.example.com',
  selectionReason: 'unit-test fixture',
};

describe('lead import', () => {
  test('imports lead, creates job in LEAD_DISCOVERED, audits selection reason', () => {
    service = makeService();
    const res = service.importLead(sampleLead, 'owner');
    assert.equal(res.outcome, 'imported');
    if (res.outcome === 'imported') {
      assert.equal(res.job.state, 'LEAD_DISCOVERED');
      assert.equal(res.lead.contactEmail, 'info@acmebakery.example.com');
      const evt = audit.listForLead(res.lead.id).find((e) => e.action === 'lead.imported');
      assert.ok(evt);
      assert.equal(evt.details?.['selectionReason'], 'unit-test fixture');
    }
  });

  test('duplicate website is rejected with audit trail', () => {
    service = makeService();
    const first = service.importLead(sampleLead);
    assert.equal(first.outcome, 'imported');
    const second = service.importLead({ ...sampleLead, businessName: 'Acme Bakery 2' });
    assert.equal(second.outcome, 'duplicate');
    if (second.outcome === 'duplicate') {
      assert.equal(second.lead.id, first.outcome === 'imported' ? first.lead.id : '');
      const evt = audit.listRecent(10).find((e) => e.action === 'lead.duplicate_skipped');
      assert.ok(evt, 'duplicate skip must be audited');
    }
  });

  test('case-insensitive website dedupe', () => {
    service = makeService();
    service.importLead(sampleLead);
    const again = service.importLead({ ...sampleLead, websiteUrl: 'HTTPS://ACMEBAKERY.example.com/about' });
    assert.equal(again.outcome, 'duplicate');
  });

  test('suppressed email blocks import', () => {
    service = makeService();
    suppressions.add('blocked@example.com', 'email', 'requested no contact', 'manual');
    const res = service.importLead({ ...sampleLead, contactEmail: 'BLOCKED@example.com' });
    assert.equal(res.outcome, 'suppressed');
    assert.ok(audit.listRecent(10).some((e) => e.action === 'lead.suppressed'));
  });

  test('suppressed domain blocks import (including www and parent forms)', () => {
    service = makeService();
    suppressions.add('spammy.example', 'domain', 'bad actor', 'manual');
    for (const url of ['https://spammy.example', 'https://www.spammy.example', 'https://shop.spammy.example']) {
      const res = service.importLead({ ...sampleLead, websiteUrl: url });
      assert.equal(res.outcome, 'suppressed', url);
    }
  });

  test('validation: business name and source required', () => {
    service = makeService();
    assert.throws(() => service.importLead({ ...sampleLead, businessName: ' ' }), /businessName/);
    assert.throws(() => service.importLead({ ...sampleLead, source: '' }), /source/);
  });
});

describe('lead research', () => {
  test('qualified research: transitions and dossier persistence', async () => {
    service = makeService();
    const imported = service.importLead(sampleLead);
    assert.ok(imported.outcome === 'imported');
    const leadId = imported.lead.id;

    const result = await service.researchLead(leadId);
    assert.equal(result.outcome, 'qualified');
    const lead = leads.requireLead(leadId);
    assert.equal(lead.score, 75);
    assert.equal(lead.confidence, 0.8);
    assert.ok(lead.dossierJson?.includes('Test Business'));
    assert.equal(jobs.requireByLeadId(leadId).state, 'READY_FOR_OUTREACH');
    assert.ok(audit.listForLead(leadId).some((e) => e.action === 'research.completed'));
    assert.ok(
      audit
        .listForLead(leadId)
        .some((e) => e.action === 'state.transition' && e.details?.['to'] === 'READY_FOR_OUTREACH'),
    );
  });

  test('research below score threshold or negative recommendation rejects lead', async () => {
    const transport: OllamaTransport = async (req) => {
      transportCalls.push({ model: req.model, task: '' });
      return { model: req.model, content: JSON.stringify(dossierPayload({ score: 30, recommendForOutreach: false, rejectionReasons: ['no web presence impact'] })), usage: {} };
    };
    service = makeService(transport);
    const imported = service.importLead(sampleLead);
    assert.ok(imported.outcome === 'imported');
    const result = await service.researchLead(imported.outcome === 'imported' ? imported.lead.id : '');
    assert.equal(result.outcome, 'rejected');
    assert.equal(jobs.requireByLeadId(imported.outcome === 'imported' ? imported.lead.id : '').state, 'LEAD_REJECTED');
    const rejection = audit.listRecent(20).find((e) => e.action === 'state.transition' && e.details?.['to'] === 'LEAD_REJECTED');
    assert.ok(rejection);
    assert.ok(String(rejection.details?.['reason']).includes('no web presence impact'));
  });

  test('researcher receives website content wrapped as untrusted data', async () => {
    service = makeService(undefined, async () => 'PLAIN TEXT OF THE WEBSITE');
    const imported = service.importLead(sampleLead);
    assert.ok(imported.outcome === 'imported');
    await service.researchLead((imported as { lead: { id: string } }).lead.id);
    assert.ok(transportCalls.length >= 1);
    const sent = transportCalls[0]!.task;
    assert.ok(sent.includes('<untrusted'), 'website content must be inside untrusted wrapper');
    assert.ok(sent.includes('PLAIN TEXT OF THE WEBSITE'));
    assert.ok(sent.includes('SECURITY RULES'));
  });

  test('website fetch failure degrades gracefully to no-website research', async () => {
    service = makeService(undefined, async () => {
      throw new ValidationError('website returned HTTP 500');
    });
    const imported = service.importLead(sampleLead);
    assert.ok(imported.outcome === 'imported');
    const result = await service.researchLead((imported as { lead: { id: string } }).lead.id);
    assert.equal(result.outcome, 'qualified');
    const sent = transportCalls[0]!.task;
    assert.ok(sent.includes('NO_PUBLIC_WEBSITE_CONTENT'));
  });

  test('AI output failure moves job to FAILED with audit, retry works', async () => {
    let fail = true;
    const transport: OllamaTransport = async () => {
      if (fail) {
        return { model: 'm', content: 'garbage not json', usage: {} };
      }
      return { model: 'm', content: JSON.stringify(dossierPayload()), usage: {} };
    };
    service = makeService(transport, async () => 'SITE');
    const imported = service.importLead(sampleLead);
    const leadId = (imported as { lead: { id: string } }).lead.id;

    const failed = await service.researchLead(leadId);
    assert.equal(failed.outcome, 'failed');
    assert.equal(jobs.requireByLeadId(leadId).state, 'FAILED');
    assert.ok(audit.listForLead(leadId).some((e) => e.action === 'research.failed'));

    fail = false;
    const retried = await service.researchLead(leadId, { actor: 'owner', actorType: 'owner' });
    assert.equal(retried.outcome, 'qualified');
    assert.equal(jobs.requireByLeadId(leadId).state, 'READY_FOR_OUTREACH');
  });

  test('research is refused from terminal states', async () => {
    service = makeService();
    const imported = service.importLead(sampleLead);
    const leadId = (imported as { lead: { id: string } }).lead.id;
    engine.transitionLead(leadId, 'LEAD_REJECTED', { actor: 'owner', actorType: 'owner' });
    await assert.rejects(() => service.researchLead(leadId), /illegal workflow transition/);
  });
});
