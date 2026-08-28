import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database.js';
import { runMigrations, MIGRATIONS, MigrationDriftError } from '../src/db/migrations.js';
import { LeadRepository } from '../src/db/repositories/leads.js';
import { WorkflowJobRepository } from '../src/db/repositories/workflowJobs.js';
import { AuditEventRepository } from '../src/db/repositories/auditEvents.js';
import { IdempotencyRepository } from '../src/db/repositories/idempotency.js';
import { WorkflowEngine } from '../src/engine/workflowEngine.js';
import { ConflictError, InvalidTransitionError } from '../src/domain/errors.js';

let db: Database;

beforeEach(() => {
  db = new Database(':memory:');
  runMigrations(db);
});

afterEach(() => {
  db.close();
});

describe('migrations', () => {
  test('are idempotent', () => {
    const second = runMigrations(db);
    assert.deepEqual(second.applied, []);
    assert.equal(second.skipped.length, MIGRATIONS.length);
  });

  test('record checksums and detect drift', () => {
    const row = db.get<{ checksum: string }>("SELECT checksum FROM schema_migrations WHERE name = '001_initial_schema'");
    assert.ok(row?.checksum);
    const original = MIGRATIONS[0]!.sql;
    try {
      (MIGRATIONS[0] as { sql: string }).sql = original + '\n-- drift';
      assert.throws(() => runMigrations(db), MigrationDriftError);
    } finally {
      (MIGRATIONS[0] as { sql: string }).sql = original;
    }
  });

  test('foreign keys are enforced', () => {
    assert.throws(() => {
      db.run("INSERT INTO leads (id, business_id, discovery_source, selection_reason, created_at, updated_at) VALUES ('lead_x', 'biz_missing', 'manual', 'test', '2026-01-01', '2026-01-01')");
    }, /FOREIGN KEY/);
  });
});

describe('workflow engine', () => {
  let leads: LeadRepository;
  let jobs: WorkflowJobRepository;
  let audit: AuditEventRepository;
  let engine: WorkflowEngine;
  let leadId: string;
  let jobId: string;

  beforeEach(() => {
    leads = new LeadRepository(db);
    jobs = new WorkflowJobRepository(db);
    audit = new AuditEventRepository(db);
    engine = new WorkflowEngine(db, jobs, audit);
    const { lead } = leads.createLead({ businessName: 'Acme Ltd', source: 'test', selectionReason: 'unit test' });
    leadId = lead.id;
    jobId = engine.getOrCreateJobForLead(leadId).id;
  });

  test('job starts in LEAD_DISCOVERED and second call returns same job', () => {
    const again = engine.getOrCreateJobForLead(leadId);
    assert.equal(again.id, jobId);
    assert.equal(again.state, 'LEAD_DISCOVERED');
  });

  test('legal transition updates state and writes audit trail', () => {
    const result = engine.transition(jobId, 'RESEARCHING', { actor: 'system', actorType: 'system' });
    assert.equal(result.from, 'LEAD_DISCOVERED');
    assert.equal(result.to, 'RESEARCHING');
    const events = audit.listForJob(jobId);
    const transition = events.find((e) => e.action === 'state.transition');
    assert.ok(transition);
    assert.deepEqual(transition.details, { from: 'LEAD_DISCOVERED', to: 'RESEARCHING' });
  });

  test('illegal transition throws and does not mutate state', () => {
    assert.throws(
      () => engine.transition(jobId, 'COMPLETED' as never, { actor: 'owner', actorType: 'owner' }),
      InvalidTransitionError,
    );
    assert.equal(jobs.requireById(jobId).state, 'LEAD_DISCOVERED');
    const rejected = audit.listForJob(jobId).filter((e) => e.action === 'state.transition_rejected');
    assert.equal(rejected.length, 1);
  });

  test('transition of unknown job id throws NotFoundError', () => {
    assert.throws(
      () => engine.transition('job_missing', 'RESEARCHING', { actor: 'system', actorType: 'system' }),
      /not found/,
    );
  });

  test('stale guarded transition loses the race with ConflictError', () => {
    // Simulate a concurrent writer: the job is now RESEARCHING, but a caller
    // still holds a stale LEAD_DISCOVERED expectation.
    engine.transition(jobId, 'RESEARCHING', { actor: 'system', actorType: 'system' });
    const changed = jobs.guardedTransition(jobId, 'LEAD_DISCOVERED', 'READY_FOR_OUTREACH', new Date().toISOString());
    assert.equal(changed, false);
    assert.equal(jobs.requireById(jobId).state, 'RESEARCHING');
  });

  test('engine surfaces ConflictError when guard loses inside transition', () => {
    const original = jobs.guardedTransition.bind(jobs);
    jobs.guardedTransition = (_jobId, expected, next, at) => {
      // simulate another writer winning just before the guarded update
      original(_jobId, expected, next === 'RESEARCHING' ? 'LEAD_REJECTED' : 'RESEARCHING', at);
      return original(_jobId, expected, next, at);
    };
    assert.throws(
      () => engine.transition(jobId, 'RESEARCHING', { actor: 'system', actorType: 'system' }),
      ConflictError,
    );
    jobs.guardedTransition = original;
    // The engine transaction rolled back, including the simulated concurrent
    // writer, so the job is unchanged from the caller's perspective.
    assert.equal(jobs.requireById(jobId).state, 'LEAD_DISCOVERED');
    const rejected = audit.listForJob(jobId).filter((e) => e.action === 'state.transition_rejected');
    assert.equal(rejected.length, 1);
  });

  test('FAILED transition records failure reason', () => {
    engine.transition(jobId, 'RESEARCHING', { actor: 'system', actorType: 'system' });
    engine.transition(jobId, 'FAILED', { actor: 'system', actorType: 'system', reason: 'ollama unreachable' });
    const job = jobs.requireById(jobId);
    assert.equal(job.state, 'FAILED');
    assert.equal(job.failureReason, 'ollama unreachable');
  });

  test('opt-out works from a non-terminal state and is then terminal', () => {
    engine.transition(jobId, 'OPTED_OUT', { actor: 'owner', actorType: 'owner', reason: 'customer request' });
    assert.throws(
      () => engine.transition(jobId, 'RESEARCHING', { actor: 'owner', actorType: 'owner' }),
      InvalidTransitionError,
    );
  });
});

describe('idempotency', () => {
  test('runOnce executes once and replays cached result', async () => {
    const repo = new IdempotencyRepository(db);
    let calls = 0;
    const first = await repo.runOnce('send:1', 'outreach', () => {
      calls++;
      return { providerId: 'p1' };
    });
    assert.equal(first.fresh, true);
    const second = await repo.runOnce('send:1', 'outreach', () => {
      calls++;
      return { providerId: 'p2' };
    });
    assert.equal(second.fresh, false);
    assert.deepEqual(second.result, { providerId: 'p1' });
    assert.equal(calls, 1);
  });

  test('in-flight key blocks duplicate execution', () => {
    const repo = new IdempotencyRepository(db);
    db.run("INSERT INTO idempotency_keys (key, scope, created_at) VALUES ('k1', 'scope', '2026-01-01')");
    void assert.rejects(() => repo.runOnce('k1', 'scope', () => 1), /in flight/);
  });

  test('failing fn releases the key so the action can be retried', async () => {
    const repo = new IdempotencyRepository(db);
    await assert.rejects(() => repo.runOnce('k3', 'scope', () => { throw new Error('boom'); }), /boom/);
    const row = db.get<{ completed_at: string | null }>("SELECT completed_at FROM idempotency_keys WHERE key = 'k3'");
    assert.equal(row, undefined, 'key row must be deleted after failure');
    let calls = 0;
    const second = await repo.runOnce('k3', 'scope', () => {
      calls++;
      return 'recovered';
    });
    assert.equal(second.fresh, true);
    assert.equal(second.result, 'recovered');
    assert.equal(calls, 1);
  });

  test('result and side effects commit atomically', async () => {
    const repo = new IdempotencyRepository(db);
    await assert.rejects(
      () =>
        repo.runOnce('k2', 'scope', () => {
          db.run("INSERT INTO suppression_entries (id, value, kind, reason, source, created_at) VALUES ('s1', 'spam.example', 'domain', 'test', 'test', '2026')");
          throw new Error('boom');
        }),
      /boom/,
    );
    assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM suppression_entries')?.c, 0);
    assert.equal(db.get<{ c: number }>('SELECT COUNT(*) AS c FROM idempotency_keys WHERE key = \'k2\'')?.c, 0);
  });

  test('replay with a different scope is rejected', async () => {
    const repo = new IdempotencyRepository(db);
    await repo.runOnce('k4', 'payments', () => 42);
    await assert.rejects(() => repo.runOnce('k4', 'outreach', () => 1), /scope/);
  });
});
