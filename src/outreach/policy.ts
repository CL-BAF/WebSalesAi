export interface SendGuardContext {
  killSwitch: boolean;
  automationPaused: boolean;
  outreachEnabled: boolean;
  emailSuppressed: boolean;
  domainSuppressed: boolean;
  sentToday: number;
  sentToDomainToday: number;
  lastSentToContactAt?: string;
  now: Date;
  limits: {
    maxPerDay: number;
    maxPerDomainPerDay: number;
    cooldownHours: number;
  };
  /**
   * False for cold outreach (all guards apply). True for replies inside an
   * existing conversation: the per-domain daily cap and per-contact cooldown
   * are anti-spam guards for cold contact and must not prevent answering a
   * customer who just wrote to us. Kill switch, pause, enablement,
   * suppression and the global daily cap still apply to replies.
   */
  isReply: boolean;
}

export type SendGuardVerdict = { allowed: true } | { allowed: false; reason: string; guard: string };

/**
 * Deterministic, pure send-guards. Applied to EVERY outbound email
 * (cold outreach and conversation replies alike). Order matters: hard
 * kill-switches first.
 */
export function evaluateSendGuards(ctx: SendGuardContext): SendGuardVerdict {
  if (ctx.killSwitch) return { allowed: false, guard: 'kill_switch', reason: 'global outreach kill switch is engaged' };
  if (ctx.automationPaused) return { allowed: false, guard: 'automation_paused', reason: 'automation is paused' };
  if (!ctx.outreachEnabled) return { allowed: false, guard: 'outreach_disabled', reason: 'outreach is not enabled (OUTREACH_ENABLED=false)' };
  if (ctx.emailSuppressed) return { allowed: false, guard: 'suppression', reason: 'recipient email is on the suppression list' };
  if (ctx.domainSuppressed) return { allowed: false, guard: 'suppression', reason: 'recipient domain is on the suppression list' };
  if (ctx.sentToday >= ctx.limits.maxPerDay) {
    return { allowed: false, guard: 'daily_limit', reason: `daily send limit reached (${ctx.sentToday}/${ctx.limits.maxPerDay})` };
  }
  if (!ctx.isReply) {
    if (ctx.sentToDomainToday >= ctx.limits.maxPerDomainPerDay) {
      return { allowed: false, guard: 'domain_daily_limit', reason: `per-domain daily limit reached (${ctx.sentToDomainToday}/${ctx.limits.maxPerDomainPerDay})` };
    }
    if (ctx.lastSentToContactAt) {
      const last = new Date(ctx.lastSentToContactAt).getTime();
      if (Number.isFinite(last)) {
        const elapsedHours = (ctx.now.getTime() - last) / 3_600_000;
        if (elapsedHours < ctx.limits.cooldownHours) {
          return {
            allowed: false,
            guard: 'cooldown',
            reason: `contact cooldown active (${elapsedHours.toFixed(1)}h elapsed, ${ctx.limits.cooldownHours}h required)`,
          };
        }
      }
    }
  }
  return { allowed: true };
}

export function startOfUtcDay(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
}
