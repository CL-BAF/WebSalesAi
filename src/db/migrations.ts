import { createHash } from 'node:crypto';
import type { Database } from './database.js';

export interface Migration {
  readonly name: string;
  readonly sql: string;
}

function checksum(sql: string): string {
  return createHash('sha256').update(sql).digest('hex');
}

const INITIAL_SCHEMA = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  name TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS businesses (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  industry TEXT,
  description TEXT,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  business_id TEXT NOT NULL REFERENCES businesses(id),
  website_url TEXT,
  contact_name TEXT,
  contact_email TEXT,
  contact_source TEXT,
  discovery_source TEXT NOT NULL,
  discovery_detail TEXT,
  score REAL,
  confidence REAL,
  dossier_json TEXT,
  selection_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_leads_website
  ON leads(LOWER(website_url)) WHERE website_url IS NOT NULL AND website_url != '';

CREATE TABLE IF NOT EXISTS workflow_jobs (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL UNIQUE REFERENCES leads(id),
  state TEXT NOT NULL,
  state_entered_at TEXT NOT NULL,
  revision_cycles INTEGER NOT NULL DEFAULT 0,
  failure_reason TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_workflow_jobs_state ON workflow_jobs(state);

CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY,
  lead_id TEXT NOT NULL REFERENCES leads(id),
  channel TEXT NOT NULL,
  external_thread_key TEXT,
  subject TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_conversations_lead ON conversations(lead_id);

CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  direction TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  sender TEXT NOT NULL,
  subject TEXT,
  body_text TEXT NOT NULL,
  external_id TEXT,
  provider TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_external
  ON messages(conversation_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected')),
  decided_by TEXT,
  decided_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_drafts_job ON outreach_drafts(job_id);

CREATE TABLE IF NOT EXISTS outreach_log (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  lead_id TEXT NOT NULL REFERENCES leads(id),
  conversation_id TEXT REFERENCES conversations(id),
  message_id TEXT REFERENCES messages(id),
  idempotency_key TEXT NOT NULL UNIQUE,
  provider TEXT NOT NULL,
  provider_message_id TEXT,
  sent_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_log_lead ON outreach_log(lead_id);
CREATE INDEX IF NOT EXISTS idx_outreach_log_sent_at ON outreach_log(sent_at);

CREATE TABLE IF NOT EXISTS suppression_entries (
  id TEXT PRIMARY KEY,
  value TEXT NOT NULL UNIQUE,
  kind TEXT NOT NULL CHECK (kind IN ('email','domain')),
  reason TEXT NOT NULL,
  source TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS website_projects (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE REFERENCES workflow_jobs(id),
  workspace_path TEXT NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS requirements (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  position INTEGER NOT NULL,
  category TEXT NOT NULL,
  title TEXT NOT NULL,
  detail TEXT NOT NULL,
  source TEXT NOT NULL,
  source_message_id TEXT REFERENCES messages(id),
  status TEXT NOT NULL DEFAULT 'active',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_requirements_job ON requirements(job_id, position);

CREATE TABLE IF NOT EXISTS agent_runs (
  id TEXT PRIMARY KEY,
  role TEXT NOT NULL,
  model TEXT NOT NULL,
  job_id TEXT REFERENCES workflow_jobs(id),
  purpose TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  status TEXT NOT NULL CHECK (status IN ('running','succeeded','failed','rejected')),
  input_json TEXT,
  output_json TEXT,
  usage_json TEXT,
  error TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_agent_runs_job ON agent_runs(job_id);

CREATE TABLE IF NOT EXISTS reviews (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  project_id TEXT NOT NULL REFERENCES website_projects(id),
  cycle INTEGER NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('PASS','CHANGES_REQUIRED')),
  findings_json TEXT,
  reviewer_run_id TEXT REFERENCES agent_runs(id),
  created_at TEXT NOT NULL,
  UNIQUE (job_id, cycle)
);

CREATE TABLE IF NOT EXISTS deployments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  project_id TEXT NOT NULL REFERENCES website_projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('preview','production')),
  provider TEXT NOT NULL,
  status TEXT NOT NULL,
  url TEXT,
  commit_hash TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_deployments_job ON deployments(job_id);

CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  provider TEXT NOT NULL,
  provider_reference TEXT,
  amount_cents INTEGER NOT NULL,
  currency TEXT NOT NULL,
  tier TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('created','paid','failed','canceled','refunded')),
  checkout_url TEXT,
  idempotency_key TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_payments_job ON payments(job_id);

CREATE TABLE IF NOT EXISTS payment_events (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  event_id TEXT NOT NULL,
  type TEXT NOT NULL,
  payment_id TEXT REFERENCES payments(id),
  payload_json TEXT,
  signature_verified INTEGER NOT NULL,
  received_at TEXT NOT NULL,
  UNIQUE (provider, event_id)
);

CREATE TABLE IF NOT EXISTS audit_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  actor_type TEXT NOT NULL,
  action TEXT NOT NULL,
  job_id TEXT,
  lead_id TEXT,
  details_json TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_events_job ON audit_events(job_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_lead ON audit_events(lead_id);
CREATE INDEX IF NOT EXISTS idx_audit_events_at ON audit_events(at);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  scope TEXT NOT NULL,
  result_json TEXT,
  created_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

export const MIGRATIONS: readonly Migration[] = [
  {
    name: '001_initial_schema',
    sql: INITIAL_SCHEMA,
  },
  {
    // Adds normalized website host for lead deduplication. Pre-existing rows
    // (dev databases only) have NULL host and keep full-URL matching.
    name: '002_leads_website_host',
    sql: `
ALTER TABLE leads ADD COLUMN website_host TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_host ON leads(website_host) WHERE website_host IS NOT NULL;
DROP INDEX IF EXISTS idx_leads_website;
`,
  },
  {
    // H4-1 transactional outbox: outreach_log rows get a processing status
    // ('sending' -> 'sent' | 'failed'); inbound messages get a processed flag
    // so a failed classification retry re-enters the pipeline (M4-2); leads
    // get a normalized contact email for '+tag'-aware matching (M4-3).
    name: '003_outbox_and_processing',
    sql: `
ALTER TABLE outreach_log ADD COLUMN status TEXT NOT NULL DEFAULT 'sent';
ALTER TABLE messages ADD COLUMN processed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE leads ADD COLUMN contact_email_normalized TEXT;
CREATE INDEX IF NOT EXISTS idx_leads_email_norm ON leads(contact_email_normalized) WHERE contact_email_normalized IS NOT NULL;
`,
  },
  {
    // Artifact binding: a review PASS binds to the exact workspace state it
    // approved — the git HEAD commit AND a content digest over all files.
    // deployProduction re-verifies both; any post-PASS mutation voids the PASS.
    name: '004_review_artifact_binding',
    sql: `
ALTER TABLE reviews ADD COLUMN artifact_commit TEXT;
ALTER TABLE reviews ADD COLUMN artifact_hash TEXT;
`,
  },
  {
    // Stage 7 domain foundation: RECORD-ONLY registration of client/deployed
    // domains. No DNS is ever modified by this schema or its repository —
    // any future DNS/domain action requires a separate owner-approved
    // provider integration that does not exist yet.
    name: '005_domain_records',
    sql: `
CREATE TABLE IF NOT EXISTS job_domains (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES workflow_jobs(id),
  kind TEXT NOT NULL CHECK (kind IN ('client_existing', 'client_desired', 'production_hostname')),
  domain TEXT NOT NULL,
  dns_status TEXT NOT NULL DEFAULT 'unknown',
  verification_state TEXT NOT NULL DEFAULT 'unverified',
  notes TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_domains_job ON job_domains(job_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_job_domains_unique ON job_domains(job_id, kind, domain);
`,
  },
];

export class MigrationDriftError extends Error {
  constructor(name: string) {
    super(`migration checksum mismatch for already-applied migration "${name}" — database was built with different schema source`);
    this.name = 'MigrationDriftError';
  }
}

export function runMigrations(db: Database): { applied: string[]; skipped: string[] } {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name TEXT PRIMARY KEY,
    checksum TEXT NOT NULL,
    applied_at TEXT NOT NULL
  );`);

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const migration of MIGRATIONS) {
    const existing = db.get<{ checksum: string }>('SELECT checksum FROM schema_migrations WHERE name = ?', migration.name);
    const sum = checksum(migration.sql);
    if (existing) {
      if (existing.checksum !== sum) {
        throw new MigrationDriftError(migration.name);
      }
      skipped.push(migration.name);
      continue;
    }
    db.transaction(() => {
      db.exec(migration.sql);
      db.run('INSERT INTO schema_migrations (name, checksum, applied_at) VALUES (?, ?, ?)', migration.name, sum, new Date().toISOString());
    });
    applied.push(migration.name);
  }

  return { applied, skipped };
}
