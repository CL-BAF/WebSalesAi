import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { createAppContext, closeAppContext, startServer, type AppContext } from '../src/index.js';
import { MockPaymentProvider } from '../src/payments/providers/mockPayment.js';
import { createHmac } from 'node:crypto';

const base = mkdtempSync(path.join(tmpdir(), 'wsa-http-'));
process.env['NODE_ENV'] = 'test';
process.env['DASHBOARD_PASSWORD'] = 'test-pw-123';
process.env['SESSION_SECRET'] = 'http-test-secret';
process.env['DATABASE_PATH'] = path.join(base, 'test.sqlite');
process.env['WORKSPACES_ROOT'] = path.join(base, 'workspaces');
process.env['PREVIEWS_ROOT'] = path.join(base, 'previews');
process.env['PRODUCTION_DEPLOYS_ROOT'] = path.join(base, 'production');
process.env['PAYMENT_WEBHOOK_SECRET'] = 'whsec_http_test';

let ctx: AppContext;
let closeServer: () => void = () => undefined;
let baseUrl = '';

before(async () => {
  ctx = createAppContext(process.env);
  const started = startServer(ctx, { port: 0 });
  const port = await started.ready;
  baseUrl = `http://127.0.0.1:${port}`;
  closeServer = started.close;
});

after(() => {
  closeServer();
  closeAppContext(ctx);
  rmSync(base, { recursive: true, force: true });
});

describe('http server (dashboard + webhooks)', () => {
  test('unauthenticated API access is rejected', async () => {
    const res = await fetch(`${baseUrl}/api/summary`);
    assert.equal(res.status, 401);
  });

  test('login: wrong password 401, correct password sets session + csrf', async () => {
    const bad = await fetch(`${baseUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'wrong' }) });
    assert.equal(bad.status, 401);

    const res = await fetch(`${baseUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pw-123' }) });
    assert.equal(res.status, 200);
    const cookies = res.headers.getSetCookie().join(';');
    assert.ok(cookies.includes('wsa_session='));
    assert.ok(cookies.includes('wsa_csrf='));
    const body = await res.json() as { csrfToken: string };
    assert.ok(body.csrfToken);
  });

  test('summary, import, and CSRF enforcement', async () => {
    const login = await fetch(`${baseUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'test-pw-123' }) });
    const csrf = (await login.json() as { csrfToken: string }).csrfToken;
    const cookie = login.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ');
    const authHeaders = { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' };

    const summary = await fetch(`${baseUrl}/api/summary`, { headers: { cookie } });
    assert.equal(summary.status, 200);
    const data = await summary.json() as { summary: Record<string, number> };
    assert.equal(data.summary.totalLeads, 0);

    // CSRF: mutation without token is forbidden.
    const noCsrf = await fetch(`${baseUrl}/api/leads/import`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ businessName: 'X' }) });
    assert.equal(noCsrf.status, 403);

    // With CSRF: import works.
    const imported = await fetch(`${baseUrl}/api/leads/import`, { method: 'POST', headers: authHeaders, body: JSON.stringify({ businessName: 'HTTP Test Co', websiteUrl: 'https://httptest.example.com', selectionReason: 'http test' }) });
    assert.equal(imported.status, 200);
    const body2 = await imported.json() as Record<string, unknown>;
    assert.equal(body2['outcome'], 'imported');

    // Detail endpoint works.
    const lead = body2['lead'] as { id: string };
    const jobsRes = await fetch(`${baseUrl}/api/jobs`, { headers: { cookie } });
    const jobs = await jobsRes.json() as { jobs: Array<{ jobId: string; businessName: string }> };
    assert.ok(jobs.jobs.some((j) => j.businessName === 'HTTP Test Co'));
    const job = jobs.jobs[0]!;
    const detail = await fetch(`${baseUrl}/api/jobs/${job.jobId}`, { headers: { cookie } });
    assert.equal(detail.status, 200);
    const detailBody = await detail.json() as Record<string, unknown>;
    assert.ok(detailBody['job']);
    void lead;
  });

  test('payment webhook: invalid signature 401, signed-but-unknown reference 200 (inert)', async () => {
    const provider = new MockPaymentProvider();
    const event = { id: 'evt_http_1', type: 'payment.succeeded' as const, reference: 'mock_cs_unknown_ref' };
    const body = JSON.stringify(event);
    const badSig = await fetch(`${baseUrl}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': 'nope' }, body });
    assert.equal(badSig.status, 401);
    const signature = createHmac('sha256', 'whsec_http_test').update(body, 'utf8').digest('hex');
    const ok = await fetch(`${baseUrl}/webhooks/payment`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-mock-signature': signature }, body });
    assert.equal(ok.status, 200);
    const parsed = await ok.json() as { handled: boolean; code: string };
    assert.equal(parsed.handled, false, 'unknown reference is accepted as processed-but-inert');
    assert.equal(parsed.code, 'unknown_reference');
    void provider;
  });

  test('email webhook requires signature', async () => {
    const res = await fetch(`${baseUrl}/webhooks/email`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ from: 'x@y.com', body: 'hi' }) });
    assert.equal(res.status, 503, 'no inbound secret configured in test env → webhook disabled (fail-closed)');
  });

  test('login rate limiting kicks in', async () => {
    let lastStatus = 0;
    for (let i = 0; i < 12; i++) {
      const res = await fetch(`${baseUrl}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: `wrong-${i}` }) });
      lastStatus = res.status;
    }
    assert.equal(lastStatus, 429);
  });
});
