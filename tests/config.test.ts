import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, ConfigError } from '../src/config.js';

const baseEnv = (): NodeJS.ProcessEnv => ({
  NODE_ENV: 'test',
  DASHBOARD_PASSWORD: 'pw',
  SESSION_SECRET: 'sec',
});

describe('config', () => {
  test('parses defaults in test env', () => {
    const cfg = loadConfig(baseEnv());
    assert.equal(cfg.nodeEnv, 'test');
    assert.equal(cfg.port, 3000);
    assert.equal(cfg.ollama.models.researcher, 'glm-5.3-flash');
    assert.equal(cfg.outreach.enabled, false);
    assert.equal(cfg.outreach.requireApproval, true);
    assert.equal(cfg.reviewMaxCycles, 5);
    assert.equal(cfg.pricing.currency, 'USD');
    assert.ok(cfg.pricing.tiers['starter']);
  });

  test('fail-closed: missing DASHBOARD_PASSWORD outside test throws', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', SESSION_SECRET: 'x' } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof ConfigError && err.issues.some((i) => i.includes('DASHBOARD_PASSWORD')),
    );
  });

  test('fail-closed: missing SESSION_SECRET outside test throws', () => {
    assert.throws(
      () => loadConfig({ NODE_ENV: 'production', DASHBOARD_PASSWORD: 'x' } as NodeJS.ProcessEnv),
      (err: unknown) => err instanceof ConfigError && err.issues.some((i) => i.includes('SESSION_SECRET')),
    );
  });

  test('fail-closed: invalid PORT rejected', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv(), PORT: 'not-a-number' }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv(), PORT: '99999' }),
      ConfigError,
    );
  });

  test('fail-closed: invalid NODE_ENV rejected', () => {
    assert.throws(
      () => loadConfig({ ...baseEnv(), NODE_ENV: 'darkness' }),
      (err: unknown) => err instanceof ConfigError && err.issues.some((i) => i.includes('NODE_ENV')),
    );
  });

  test('per-role model overrides fall back to OLLAMA_MODEL', () => {
    const cfg = loadConfig({ ...baseEnv(), OLLAMA_MODEL: 'base-model', OLLAMA_MODEL_REVIEWER: 'reviewer-model' });
    assert.equal(cfg.ollama.models.researcher, 'base-model');
    assert.equal(cfg.ollama.models.reviewer, 'reviewer-model');
  });

  test('pricing tiers JSON parsed and validated', () => {
    const cfg = loadConfig({ ...baseEnv(), PRICING_TIERS_JSON: '{"tiny":100}' });
    assert.deepEqual(cfg.pricing.tiers, { tiny: 100 });
    assert.throws(
      () => loadConfig({ ...baseEnv(), PRICING_TIERS_JSON: 'not json' }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv(), PRICING_TIERS_JSON: '{"tiny":-5}' }),
      ConfigError,
    );
    assert.throws(
      () => loadConfig({ ...baseEnv(), PRICING_TIERS_JSON: '{}' }),
      ConfigError,
    );
  });

  test('boolean parsing is strict', () => {
    assert.equal(loadConfig({ ...baseEnv(), OUTREACH_ENABLED: 'true' }).outreach.enabled, true);
    assert.equal(loadConfig({ ...baseEnv(), OUTREACH_ENABLED: '0' }).outreach.enabled, false);
    assert.throws(() => loadConfig({ ...baseEnv(), OUTREACH_ENABLED: 'maybe' }), ConfigError);
  });
});
