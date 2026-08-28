import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { LeadRepository } from '../src/db/repositories/leads.js';
import { WorkflowJobRepository } from '../src/db/repositories/workflowJobs.js';
import { AuditEventRepository } from '../src/db/repositories/auditEvents.js';
import { WorkflowEngine } from '../src/engine/workflowEngine.js';
import { InvalidTransitionError } from '../src/domain/errors.js';

let db: Database;
let leads: LeadRepository;
let jobs: WorkflowJobRepository;
let audit: AuditEventRepository;
let engine: WorkflowEngine;
let jobId: string;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
  leads = new LeadRepository(db);
  jobs = new WorkflowJobRepository(db);
  audit = new AuditEventRepository(db);
  engine = new WorkflowEngine(db, jobs, audit);
  const { lead } = leads.createLead({ businessName: 'Actor Test Co', source: 'test', selectionReason: 'test' });
  jobId = engine.getOrCreateJobForLead(lead.id).id;
});

afterEach(() => {
  db.close();
});

/** Drives a job along the golden path to a given state with system actors. */
async function driveTo(target: string): Promise<void> {
  const path: Record<string, string[]> = {
    AWAITING_PAYMENT: ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED', 'AWAITING_PAYMENT'],
    AWAITING_OUTREACH_APPROVAL: ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL'],
    NEEDS_HUMAN_REVIEW: ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL'],
    READY_FOR_PRODUCTION: ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED', 'AWAITING_PAYMENT', 'PAYMENT_CONFIRMED', 'READY_FOR_PRODUCTION'],
    DEPLOYING: ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL', 'OUTREACH_SENT', 'AWAITING_REPLY', 'CONVERSATION_ACTIVE', 'INTERESTED', 'REQUIREMENTS_PENDING', 'READY_TO_BUILD', 'BUILDING', 'REVIEWING', 'PREVIEW_READY', 'PREVIEW_SENT', 'AWAITING_CLIENT_APPROVAL', 'CLIENT_APPROVED', 'AWAITING_PAYMENT', 'PAYMENT_CONFIRMED', 'READY_FOR_PRODUCTION', 'DEPLOYING'],
  };
  for (const step of path[target] ?? []) {
    // Payment truth must come from the provider, mirroring production flow.
    const actorType = step === 'PAYMENT_CONFIRMED' ? 'provider' : 'system';
    engine.transition(jobId, step as never, { actor: actorType, actorType });
  }
}

describe('actor-gated privileged transitions', () => {
  test('agent CANNOT confirm payment; provider and owner can', async () => {
    await driveTo('AWAITING_PAYMENT');
    assert.throws(
      () => engine.transition(jobId, 'PAYMENT_CONFIRMED', { actor: 'agent:sales', actorType: 'agent' }),
      (err: unknown) => err instanceof InvalidTransitionError && err.message.includes('agent'),
    );
    assert.equal(jobs.requireById(jobId).state, 'AWAITING_PAYMENT');
    const provider = engine.transition(jobId, 'PAYMENT_CONFIRMED', { actor: 'payment-provider', actorType: 'provider' });
    assert.equal(provider.to, 'PAYMENT_CONFIRMED');
    const rejected = audit.listForJob(jobId).filter((e) => e.action === 'state.transition_rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0]!.details?.['to'], 'PAYMENT_CONFIRMED');
  });

  test('agent CANNOT send outreach from approval state; owner and system can', async () => {
    await driveTo('AWAITING_OUTREACH_APPROVAL');
    assert.throws(
      () => engine.transition(jobId, 'OUTREACH_SENT', { actor: 'agent:sales', actorType: 'agent' }),
      InvalidTransitionError,
    );
    const owner = engine.transition(jobId, 'OUTREACH_SENT', { actor: 'owner', actorType: 'owner' });
    assert.equal(owner.to, 'OUTREACH_SENT');
  });

  test('agent CANNOT exit NEEDS_HUMAN_REVIEW; only owner can', async () => {
    await driveTo('NEEDS_HUMAN_REVIEW');
    engine.transition(jobId, 'NEEDS_HUMAN_REVIEW', { actor: 'system', actorType: 'system', reason: 'test' });
    for (const target of ['BUILDING', 'READY_TO_BUILD', 'DEPLOYING', 'RESEARCHING'] as const) {
      assert.throws(
        () => engine.transition(jobId, target, { actor: 'agent:builder', actorType: 'agent' }),
        InvalidTransitionError,
        `agent -> ${target} must be blocked`,
      );
    }
    const owner = engine.transition(jobId, 'READY_TO_BUILD', { actor: 'owner', actorType: 'owner' });
    assert.equal(owner.to, 'READY_TO_BUILD');
  });

  test('agent CANNOT trigger production deploy or completion', async () => {
    await driveTo('READY_FOR_PRODUCTION');
    assert.throws(
      () => engine.transition(jobId, 'DEPLOYING', { actor: 'agent:builder', actorType: 'agent' }),
      InvalidTransitionError,
    );
    const sys = engine.transition(jobId, 'DEPLOYING', { actor: 'system', actorType: 'system' });
    assert.equal(sys.to, 'DEPLOYING');
    assert.throws(
      () => engine.transition(jobId, 'COMPLETED', { actor: 'agent:reviewer', actorType: 'agent' }),
      InvalidTransitionError,
    );
    assert.equal(jobs.requireById(jobId).state, 'DEPLOYING');
  });

  test('agent CANNOT opt out, fail, or request human review unilaterally', async () => {
    for (const target of ['OPTED_OUT', 'NEEDS_HUMAN_REVIEW', 'FAILED'] as const) {
      assert.throws(
        () => engine.transition(jobId, target, { actor: 'agent:sales', actorType: 'agent' }),
        InvalidTransitionError,
        `agent -> ${target} must be blocked`,
      );
    }
    assert.ok(engine.transition(jobId, 'OPTED_OUT', { actor: 'owner', actorType: 'owner' }));
  });

  test('system CAN mark FAILED (pipeline failures) but agent cannot', () => {
    engine.transition(jobId, 'RESEARCHING', { actor: 'system', actorType: 'system' });
    assert.throws(
      () => engine.transition(jobId, 'FAILED', { actor: 'agent:researcher', actorType: 'agent' }),
      InvalidTransitionError,
    );
    const sys = engine.transition(jobId, 'FAILED', { actor: 'system', actorType: 'system', reason: 'transport down' });
    assert.equal(sys.to, 'FAILED');
  });

  test('agents CAN perform ordinary pipeline transitions', () => {
    for (const step of ['RESEARCHING', 'READY_FOR_OUTREACH', 'AWAITING_OUTREACH_APPROVAL'] as const) {
      engine.transition(jobId, step, { actor: 'agent:sales', actorType: 'agent' });
    }
    // Sending is a privileged edge: human approval, then system send.
    engine.transition(jobId, 'OUTREACH_SENT', { actor: 'owner', actorType: 'owner' });
    engine.transition(jobId, 'AWAITING_REPLY', { actor: 'system', actorType: 'system' });
    engine.transition(jobId, 'CONVERSATION_ACTIVE', { actor: 'agent:sales', actorType: 'agent' });
    const res = engine.transition(jobId, 'INTERESTED', { actor: 'agent:sales', actorType: 'agent' });
    assert.equal(res.to, 'INTERESTED');
  });

  test('owner CANNOT be blocked from privileged edges (owner override)', async () => {
    await driveTo('READY_FOR_PRODUCTION');
    const res = engine.transition(jobId, 'DEPLOYING', { actor: 'owner', actorType: 'owner' });
    assert.equal(res.to, 'DEPLOYING');
  });
});
