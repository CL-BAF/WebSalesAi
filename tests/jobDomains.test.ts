import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Database } from '../src/db/database.js';
import { runMigrations } from '../src/db/migrations.js';
import { JobDomainRepository } from '../src/db/repositories/jobDomains.js';
import { LeadRepository } from '../src/db/repositories/leads.js';
import { WorkflowJobRepository } from '../src/db/repositories/workflowJobs.js';
import { AuditEventRepository } from '../src/db/repositories/auditEvents.js';
import { WorkflowEngine } from '../src/engine/workflowEngine.js';
import { ValidationError } from '../src/domain/errors.js';

function setup(): { repo: JobDomainRepository; jobId: string } {
  const db = new Database(':memory:');
  runMigrations(db);
  const leads = new LeadRepository(db);
  const { lead } = leads.createLead({ businessName: 'Domain Test Co', source: 'test', selectionReason: 'test' });
  const engine = new WorkflowEngine(db, new WorkflowJobRepository(db), new AuditEventRepository(db));
  const job = engine.getOrCreateJobForLead(lead.id);
  return { repo: new JobDomainRepository(db), jobId: job.id };
}

describe('S7 job_domains ledger (record-only, no DNS authority)', () => {
  test('records client/desired/production domains with dns + verification state', () => {
    const { repo, jobId } = setup();
    const existing = repo.record({ jobId, kind: 'client_existing', domain: 'Client-Site.COM.AU', dnsStatus: 'active', verificationState: 'verified' });
    assert.equal(existing.domain, 'client-site.com.au', 'domains are normalized lowercase');
    assert.equal(existing.verificationState, 'verified');

    const desired = repo.record({ jobId, kind: 'client_desired', domain: 'newname.com.au' });
    assert.equal(desired.dnsStatus, 'unknown');
    assert.equal(desired.verificationState, 'unverified');

    const host = repo.record({ jobId, kind: 'production_hostname', domain: 'WWW.AcmeBakery.com.au' });
    assert.equal(host.kind, 'production_hostname');

    const rows = repo.listByJob(jobId);
    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.kind), ['client_existing', 'client_desired', 'production_hostname']);
  });

  test('upsert: same (job, kind, domain) updates in place, no duplicate rows', () => {
    const { repo, jobId } = setup();
    repo.record({ jobId, kind: 'client_desired', domain: 'newname.com.au', dnsStatus: 'unknown' });
    const updated = repo.record({ jobId, kind: 'client_desired', domain: 'newname.com.au', dnsStatus: 'propagating', verificationState: 'pending' });
    assert.equal(updated.dnsStatus, 'propagating');
    assert.equal(updated.verificationState, 'pending');
    assert.equal(repo.listByJob(jobId).length, 1, 'upsert must not create a duplicate row');
  });

  test('malformed domains are rejected (no traversal, no junk, no single labels)', () => {
    const repo = new JobDomainRepository(new Database(':memory:'));
    const badDomains = ['../evil.com', 'not a domain', 'https://x.com', '-leadingdash.com', 'x', '', 'con'];
    for (const bad of badDomains) {
      assert.throws(
        () => repo.record({ jobId: 'job_x', kind: 'client_desired', domain: bad }),
        ValidationError,
        `domain ${JSON.stringify(bad)} must be rejected`,
      );
    }
    // Single-label hostnames without a dot are not registrable domains.
    assert.throws(() => void repo.record({ jobId: 'job_x', kind: 'client_desired', domain: 'localhost' }), ValidationError);
  });
});