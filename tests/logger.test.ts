import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { redactSecrets, REDACT_PATHS } from '../src/logger.js';
import { pino } from 'pino';

describe('secret redaction', () => {
  test('deep redaction masks secret-looking keys', () => {
    const input = {
      OLLAMA_API_KEY: 'sk-live-123',
      SESSION_SECRET: 'super-secret',
      dashboardPassword: 'hunter2',
      nested: {
        authToken: 'tok_abc',
        PAYMENT_WEBHOOK_SECRET: 'whsec_1',
        safe: 'visible',
      },
      list: [{ credential: 'cred-1', name: 'ok' }],
    };
    const redacted = redactSecrets(input) as typeof input;
    assert.equal(redacted.OLLAMA_API_KEY, '[REDACTED]');
    assert.equal(redacted.SESSION_SECRET, '[REDACTED]');
    assert.equal(redacted.dashboardPassword, '[REDACTED]');
    assert.equal(redacted.nested.authToken, '[REDACTED]');
    assert.equal(redacted.nested.PAYMENT_WEBHOOK_SECRET, '[REDACTED]');
    assert.equal(redacted.nested.safe, 'visible');
    assert.equal(redacted.list[0]!.credential, '[REDACTED]');
    assert.equal(redacted.list[0]!.name, 'ok');
  });

  test('non-secret keys are preserved', () => {
    const input = { idempotency_key: 'send:1', apiKeyless: 'value', job_id: 'job_1' };
    const redacted = redactSecrets(input) as typeof input;
    assert.equal(redacted.idempotency_key, 'send:1');
    assert.equal(redacted.job_id, 'job_1');
  });

  test('pino redacts configured secret paths in serialized output', () => {
    const chunks: string[] = [];
    const stream = {
      write(chunk: string) {
        chunks.push(chunk);
      },
    };
    const log = pino({ level: 'info', redact: { paths: REDACT_PATHS, censor: '[REDACTED]' } }, stream as never);
    log.info(
      {
        OLLAMA_API_KEY: 'sk-live-123',
        SESSION_SECRET: 'sess',
        DASHBOARD_PASSWORD: 'pw',
        req: { headers: { authorization: 'Bearer xyz', cookie: 'sid=1' } },
        visible: 'data',
      },
      'test event',
    );
    assert.equal(chunks.length, 1);
    const line = JSON.parse(chunks[0]!) as Record<string, unknown>;
    assert.equal(line['OLLAMA_API_KEY'], '[REDACTED]');
    assert.equal(line['SESSION_SECRET'], '[REDACTED]');
    assert.equal(line['DASHBOARD_PASSWORD'], '[REDACTED]');
    const req = line['req'] as { headers: Record<string, string> };
    assert.equal(req.headers['authorization'], '[REDACTED]');
    assert.equal(req.headers['cookie'], '[REDACTED]');
    assert.equal(line['visible'], 'data');
    assert.ok(!chunks[0]!.includes('sk-live-123'));
    assert.ok(!chunks[0]!.includes('Bearer xyz'));
  });

  test('audit repository redacts details before persisting', async () => {
    const { Database } = await import('../src/db/database.js');
    const { runMigrations } = await import('../src/db/migrations.js');
    const { AuditEventRepository } = await import('../src/db/repositories/auditEvents.js');
    const db = new Database(':memory:');
    runMigrations(db);
    const audit = new AuditEventRepository(db);
    audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'test.action',
      details: { apiKey: 'sk-123', payload: 'data' },
    });
    const row = db.get<{ details_json: string }>("SELECT details_json FROM audit_events WHERE action = 'test.action'");
    assert.ok(row?.details_json);
    assert.ok(!row.details_json.includes('sk-123'));
    assert.ok(row.details_json.includes('[REDACTED]'));
    assert.ok(row.details_json.includes('data'));
    db.close();
  });
});
