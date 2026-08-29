import { newId, nowIso } from '../../domain/ids.js';
import { ValidationError } from '../../domain/errors.js';
import type { Database } from '../database.js';

export interface JobDomainRecord {
  id: string;
  jobId: string;
  kind: 'client_existing' | 'client_desired' | 'production_hostname';
  domain: string;
  dnsStatus: string;
  verificationState: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

function rowToDomain(row: Record<string, unknown>): JobDomainRecord {
  return {
    id: String(row['id']),
    jobId: String(row['job_id']),
    kind: row['kind'] as JobDomainRecord['kind'],
    domain: String(row['domain']),
    dnsStatus: String(row['dns_status']),
    verificationState: String(row['verification_state']),
    notes: (row['notes'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

/**
 * Stage 7 domain foundation — RECORD-ONLY.
 *
 * This repository registers and tracks domain information (existing client
 * domain, desired domain, production hostname, DNS status, verification
 * state). It deliberately has NO capability to purchase domains, modify DNS
 * records, or talk to any registrar/DNS API. Any future DNS/domain action
 * must be a separate, explicitly owner-approved provider integration; until
 * then this ledger is purely informational and audited.
 */
export class JobDomainRepository {
  constructor(private readonly db: Database) {}

  record(input: {
    jobId: string;
    kind: 'client_existing' | 'client_desired' | 'production_hostname';
    domain: string;
    dnsStatus?: string;
    verificationState?: string;
    notes?: string;
  }): JobDomainRecord {
    const at = nowIso();
    const domain = input.domain.trim().toLowerCase();
    if (!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(domain)) {
      throw new ValidationError(`invalid domain: ${input.domain}`);
    }
    this.db.run(
      `INSERT INTO job_domains (id, job_id, kind, domain, dns_status, verification_state, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(job_id, kind, domain) DO UPDATE SET
         dns_status = excluded.dns_status,
         verification_state = excluded.verification_state,
         notes = excluded.notes,
         updated_at = excluded.updated_at`,
      newId('dom'),
      input.jobId,
      input.kind,
      domain,
      input.dnsStatus ?? 'unknown',
      input.verificationState ?? 'unverified',
      input.notes ?? null,
      at,
      at,
    );
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM job_domains WHERE job_id = ? AND kind = ? AND domain = ?',
      input.jobId,
      input.kind,
      domain,
    );
    return {
      id: String(row!['id']),
      jobId: String(row!['job_id']),
      kind: row!['kind'] as JobDomainRecord['kind'],
      domain: String(row!['domain']),
      dnsStatus: String(row!['dns_status']),
      verificationState: String(row!['verification_state']),
      notes: (row!['notes'] as string | null) ?? null,
      createdAt: String(row!['created_at']),
      updatedAt: String(row!['updated_at']),
    };
  }

  listByJob(jobId: string): JobDomainRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM job_domains WHERE job_id = ? ORDER BY created_at ASC', jobId)
      .map((row) => ({
        id: String(row['id']),
        jobId: String(row['job_id']),
        kind: row['kind'] as JobDomainRecord['kind'],
        domain: String(row['domain']),
        dnsStatus: String(row['dns_status']),
        verificationState: String(row['verification_state']),
        notes: (row['notes'] as string | null) ?? null,
        createdAt: String(row['created_at']),
        updatedAt: String(row['updated_at']),
      }));
  }
}
