import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSendGuards, startOfUtcDay, type SendGuardContext } from '../src/outreach/policy.js';

  function baseCtx(overrides: Partial<SendGuardContext> = {}): SendGuardContext {
    return {
      killSwitch: false,
      automationPaused: false,
      outreachEnabled: true,
      emailSuppressed: false,
      domainSuppressed: false,
      sentToday: 0,
      sentToDomainToday: 0,
      now: new Date('2026-08-29T12:00:00Z'),
      limits: { maxPerDay: 20, maxPerDomainPerDay: 1, cooldownHours: 72 },
      isReply: false,
      ...overrides,
    };
  }

describe('outreach send guards (policy)', () => {
  test('allows a clean send', () => {
    assert.deepEqual(evaluateSendGuards(baseCtx()), { allowed: true });
  });

  test('kill switch wins over everything', () => {
    const v = evaluateSendGuards(baseCtx({ killSwitch: true }));
    assert.equal(v.allowed, false);
    if (!v.allowed) assert.equal(v.guard, 'kill_switch');
  });

  test('pause blocks', () => {
    const v = evaluateSendGuards(baseCtx({ automationPaused: true }));
    assert.ok(!v.allowed && v.guard === 'automation_paused');
  });

  test('outreach disabled blocks (MVP default)', () => {
    const v = evaluateSendGuards(baseCtx({ outreachEnabled: false }));
    assert.ok(!v.allowed && v.guard === 'outreach_disabled');
  });

  test('email and domain suppression block', () => {
    const v1 = evaluateSendGuards(baseCtx({ emailSuppressed: true }));
    const v2 = evaluateSendGuards(baseCtx({ domainSuppressed: true }));
    assert.ok(!v1.allowed && v1.guard === 'suppression');
    assert.ok(!v2.allowed && v2.guard === 'suppression');
  });

  test('daily limit blocks at cap', () => {
    const v = evaluateSendGuards(baseCtx({ sentToday: 20 }));
    assert.ok(!v.allowed && v.guard === 'daily_limit');
  });

  test('per-domain daily limit blocks at cap', () => {
    const v = evaluateSendGuards(baseCtx({ sentToDomainToday: 1 }));
    assert.ok(!v.allowed && v.guard === 'domain_daily_limit');
  });

  test('cooldown blocks within window, allows after', () => {
    const last = new Date('2026-08-27T12:00:00Z').toISOString();
    const v = evaluateSendGuards(baseCtx({ lastSentToContactAt: last }));
    assert.ok(!v.allowed && v.guard === 'cooldown');
    const old = new Date('2026-08-20T12:00:00Z').toISOString();
    assert.deepEqual(evaluateSendGuards(baseCtx({ lastSentToContactAt: old })), { allowed: true });
  });

  test('replies skip domain daily cap and cooldown but keep global cap and suppression', () => {
    // Reply to a domain already contacted today + inside cooldown: allowed.
    const last = new Date('2026-08-29T10:00:00Z').toISOString(); // 2h ago
    assert.deepEqual(
      evaluateSendGuards(baseCtx({ isReply: true, sentToDomainToday: 1, lastSentToContactAt: last })),
      { allowed: true },
    );
    // Global daily cap still applies to replies.
    const capped = evaluateSendGuards(baseCtx({ isReply: true, sentToday: 20 }));
    assert.ok(!capped.allowed && capped.guard === 'daily_limit');
    // Suppression still applies to replies.
    const suppressed = evaluateSendGuards(baseCtx({ isReply: true, emailSuppressed: true }));
    assert.ok(!suppressed.allowed && suppressed.guard === 'suppression');
    // Kill switch still applies to replies.
    const killed = evaluateSendGuards(baseCtx({ isReply: true, killSwitch: true }));
    assert.ok(!killed.allowed && killed.guard === 'kill_switch');
  });

  test('guards are ordered: kill switch before suppression', () => {
    const v = evaluateSendGuards(baseCtx({ killSwitch: true, emailSuppressed: true }));
    assert.ok(!v.allowed && v.guard === 'kill_switch');
  });

  test('startOfUtcDay boundaries', () => {
    assert.equal(startOfUtcDay(new Date('2026-08-29T23:59:59Z')), '2026-08-29T00:00:00.000Z');
    assert.equal(startOfUtcDay(new Date('2026-08-29T00:00:00Z')), '2026-08-29T00:00:00.000Z');
  });
});
