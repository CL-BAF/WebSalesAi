import test from 'node:test';
import assert from 'node:assert/strict';
import { buildWranglerChildEnv } from '../src/website/exec.js';

test('M-S5-1: wrangler child env carries only allowlisted OS keys plus approved passthrough', () => {
  const env = buildWranglerChildEnv({
    CLOUDFLARE_API_TOKEN: 'cf-token-xyz',
    CLOUDFLARE_ACCOUNT_ID: 'acct-123',
    CI: 'true',
    STRIPE_SECRET_KEY: 'sk_live_forged',
    RESEND_API_KEY: 're_forged',
    DASHBOARD_PASSWORD: 'hunter2',
    WSA_PHASE2_STRIPE_SECRET: 'sk_live_forged',
  });

  assert.equal(env['CLOUDFLARE_API_TOKEN'], 'cf-token-xyz', 'approved Cloudflare token passes through');
  assert.equal(env['CLOUDFLARE_ACCOUNT_ID'], 'acct-123');
  assert.equal(env['CI'], 'true');
  assert.equal(env['STRIPE_SECRET_KEY'], undefined, 'stripe key must not reach the child');
  assert.equal(env['RESEND_API_KEY'], undefined, 'email key must not reach the child');
  assert.equal(env['DASHBOARD_PASSWORD'], undefined, 'dashboard password must not reach the child');
  assert.ok(env['PATH'], 'PATH must be present for the tool to run');
});