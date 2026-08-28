import { loadConfigOrExit } from './config.js';
import { createLogger } from './logger.js';
import { Database } from './db/database.js';
import { runMigrations } from './db/migrations.js';
import { AuditEventRepository } from './db/repositories/auditEvents.js';
import { WorkflowJobRepository } from './db/repositories/workflowJobs.js';
import { LeadRepository } from './db/repositories/leads.js';
import { SettingsRepository, SETTING_KEYS } from './db/repositories/settings.js';
import { IdempotencyRepository } from './db/repositories/idempotency.js';
import { WorkflowEngine } from './engine/workflowEngine.js';

export interface AppContext {
  config: ReturnType<typeof loadConfigOrExit>;
  log: ReturnType<typeof createLogger>;
  db: Database;
  audit: AuditEventRepository;
  jobs: WorkflowJobRepository;
  leads: LeadRepository;
  settings: SettingsRepository;
  idempotency: IdempotencyRepository;
  engine: WorkflowEngine;
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
  const engine = new WorkflowEngine(db, jobs, audit);

  // Seed runtime safety switches from env (runtime changes go through settings).
  if (settings.get(SETTING_KEYS.outreachKillSwitch) === undefined) {
    settings.setBool(SETTING_KEYS.outreachKillSwitch, config.outreach.killSwitchInitial);
  }
  if (settings.get(SETTING_KEYS.automationPaused) === undefined) {
    settings.setBool(SETTING_KEYS.automationPaused, config.automationPausedInitial);
  }

  return { config, log, db, audit, jobs, leads, settings, idempotency, engine };
}

export function closeAppContext(ctx: AppContext): void {
  ctx.db.close();
}

const isDirectRun = process.argv[1] !== undefined && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop() ?? '');

if (isDirectRun) {
  const ctx = createAppContext();
  ctx.log.info({ port: ctx.config.port, nodeEnv: ctx.config.nodeEnv }, 'WebSalesAi core initialized');
  closeAppContext(ctx);
}
