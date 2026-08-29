import { z } from 'zod';

export class ConfigError extends Error {
  readonly issues: string[];
  constructor(message: string, issues: string[]) {
    super(message);
    this.name = 'ConfigError';
    this.issues = issues;
  }
}

function parseBool(raw: string): boolean {
  const v = raw.trim().toLowerCase();
  if (['true', '1', 'yes', 'on'].includes(v)) return true;
  if (['false', '0', 'no', 'off'].includes(v)) return false;
  throw new Error(`invalid boolean: "${raw}"`);
}

const boolish = z
  .string()
  .transform((s) => parseBool(s));

const int = (opts: { min?: number; max?: number; default?: number }) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw.trim() === '') {
        if (opts.default !== undefined) return opts.default;
        throw new Error('required integer missing');
      }
      const n = Number(raw);
      if (!Number.isInteger(n)) throw new Error(`invalid integer: "${raw}"`);
      if (opts.min !== undefined && n < opts.min) throw new Error(`must be >= ${opts.min}`);
      if (opts.max !== undefined && n > opts.max) throw new Error(`must be <= ${opts.max}`);
      return n;
    });

const str = (defaultValue?: string) =>
  z
    .string()
    .optional()
    .transform((raw) => {
      if (raw === undefined || raw === '') {
        if (defaultValue !== undefined) return defaultValue;
        return undefined;
      }
      return raw;
    });

const requiredStr = z
  .string()
  .optional()
  .transform((raw) => {
    if (raw === undefined || raw.trim() === '') throw new Error('required value missing');
    return raw.trim();
  });

const pricingTiersSchema = z.record(z.string().min(1).max(32).regex(/^[a-z0-9_-]+$/), z.number().int().positive());

const pricingTiers = z
  .string()
  .optional()
  .transform((raw) => {
    const defaultValue: Record<string, number> = {
      starter: 49900,
      business: 89900,
      premium: 149900,
    };
    if (raw === undefined || raw.trim() === '') return defaultValue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error('PRICING_TIERS_JSON is not valid JSON');
    }
    const result = pricingTiersSchema.safeParse(parsed);
    if (!result.success) throw new Error('PRICING_TIERS_JSON must be an object of tier name -> positive integer cents');
    if (Object.keys(result.data).length === 0) throw new Error('PRICING_TIERS_JSON must define at least one tier');
    return result.data;
  });

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).optional().transform((v) => v ?? 'development'),
  PORT: int({ min: 1, max: 65535, default: 3000 }),
  DATABASE_PATH: str('./data/websalesai.sqlite'),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .optional()
    .transform((v) => v ?? 'info'),
  PUBLIC_BASE_URL: str('http://localhost:3000'),

  DASHBOARD_PASSWORD: z.string().optional(),
  SESSION_SECRET: z.string().optional(),

  OLLAMA_BASE_URL: str('https://ollama.com'),
  OLLAMA_API_KEY: z.string().optional(),
  OLLAMA_MODEL: str('glm-5.3-flash'),
  OLLAMA_MODEL_RESEARCHER: z.string().optional(),
  OLLAMA_MODEL_SALES: z.string().optional(),
  OLLAMA_MODEL_BUILDER: z.string().optional(),
  OLLAMA_MODEL_REVIEWER: z.string().optional(),
  OLLAMA_TIMEOUT_MS: int({ min: 1000, max: 900000, default: 120000 }),
  OLLAMA_MAX_REPAIR_RETRIES: int({ min: 0, max: 5, default: 2 }),
  OLLAMA_TRANSPORT_RETRIES: int({ min: 0, max: 5, default: 2 }),

  REVIEW_MAX_CYCLES: int({ min: 1, max: 20, default: 5 }),
  REQUIRE_PAYMENT_FOR_PRODUCTION: boolish.optional().transform((v) => (v === undefined ? true : v)),

  EMAIL_PROVIDER: z.enum(['mock', 'resend']).optional().transform((v) => v ?? 'mock'),
  PAYMENT_PROVIDER: z.enum(['mock', 'stripe']).optional().transform((v) => v ?? 'mock'),
  DEPLOYMENT_PROVIDER: z.enum(['local', 'cloudflare']).optional().transform((v) => v ?? 'local'),

  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM: z.string().optional(),
  RESEND_SENDER_DOMAIN: z.string().optional(),
  RESEND_WEBHOOK_SECRET: z.string().optional(),

  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),

  CLOUDFLARE_API_TOKEN: z.string().optional(),
  CLOUDFLARE_ACCOUNT_ID: z.string().optional(),
  CLOUDFLARE_PAGES_PROJECT: z.string().optional(),

  OUTREACH_ENABLED: boolish.optional().transform((v) => (v === undefined ? false : v)),
  OUTREACH_REQUIRE_APPROVAL: boolish.optional().transform((v) => (v === undefined ? true : v)),
  OUTREACH_MAX_PER_DAY: int({ min: 1, max: 1000, default: 20 }),
  OUTREACH_MAX_PER_DOMAIN_PER_DAY: int({ min: 1, max: 100, default: 1 }),
  OUTREACH_COOLDOWN_HOURS: int({ min: 1, max: 24 * 90, default: 72 }),
  OUTREACH_MIN_SCORE: int({ min: 0, max: 100, default: 60 }),
  OUTREACH_KILL_SWITCH: boolish.optional().transform((v) => (v === undefined ? false : v)),
  AUTOMATION_PAUSED: boolish.optional().transform((v) => (v === undefined ? false : v)),

  PAYMENT_WEBHOOK_SECRET: z.string().optional(),
  INBOUND_EMAIL_WEBHOOK_SECRET: z.string().optional(),

  WORKSPACES_ROOT: str('./workspaces'),
  PREVIEWS_ROOT: str('./previews'),
  PRODUCTION_DEPLOYS_ROOT: str('./production-deploys'),

  PRICING_CURRENCY: str('USD'),
  PRICING_TIERS_JSON: pricingTiers,

  FETCH_TIMEOUT_MS: int({ min: 1000, max: 120000, default: 20000 }),
  FETCH_MAX_BYTES: int({ min: 1024, max: 50_000_000, default: 2_000_000 }),
  EXEC_TIMEOUT_MS: int({ min: 1000, max: 600000, default: 120000 }),
});

export type AppConfig = {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  databasePath: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';
  publicBaseUrl: string;

  dashboardPassword: string;
  sessionSecret: string;

  ollama: {
    baseUrl: string;
    apiKey?: string;
    models: {
      researcher: string;
      sales: string;
      builder: string;
      reviewer: string;
    };
    timeoutMs: number;
    maxRepairRetries: number;
    transportRetries: number;
  };

  reviewMaxCycles: number;
  requirePaymentForProduction: boolean;

  emailProvider: 'mock' | 'resend';
  paymentProvider: 'mock' | 'stripe';
  deploymentProvider: 'local' | 'cloudflare';

  resend: {
    apiKey?: string;
    from?: string;
    senderDomain?: string;
    webhookSecret?: string;
  };

  stripe: {
    secretKey?: string;
    webhookSecret?: string;
  };

  cloudflare: {
    apiToken?: string;
    accountId?: string;
    pagesProject?: string;
  };

  outreach: {
    enabled: boolean;
    requireApproval: boolean;
    maxPerDay: number;
    maxPerDomainPerDay: number;
    cooldownHours: number;
    minScore: number;
    killSwitchInitial: boolean;
  };

  automationPausedInitial: boolean;

  paymentWebhookSecret?: string;
  inboundEmailWebhookSecret?: string;

  workspacesRoot: string;
  previewsRoot: string;
  productionDeploysRoot: string;

  pricing: {
    currency: string;
    tiers: Record<string, number>;
  };

  fetchTimeoutMs: number;
  fetchMaxBytes: number;
  execTimeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const issues: string[] = [];
  const parsed: Record<string, unknown> = {};

  const nodeEnv = env['NODE_ENV'] === 'test' ? 'test' : env['NODE_ENV'] === 'production' ? 'production' : env['NODE_ENV'] === 'development' || env['NODE_ENV'] === undefined || env['NODE_ENV'] === '' ? 'development' : null;
  if (nodeEnv === null) issues.push('NODE_ENV must be one of development|test|production');
  parsed['NODE_ENV'] = nodeEnv;

  const schemaKeys = ['PORT', 'DATABASE_PATH', 'LOG_LEVEL', 'PUBLIC_BASE_URL', 'OLLAMA_BASE_URL', 'OLLAMA_MODEL', 'OLLAMA_MODEL_RESEARCHER', 'OLLAMA_MODEL_SALES', 'OLLAMA_MODEL_BUILDER', 'OLLAMA_MODEL_REVIEWER', 'OLLAMA_TIMEOUT_MS', 'OLLAMA_MAX_REPAIR_RETRIES', 'OLLAMA_TRANSPORT_RETRIES', 'REVIEW_MAX_CYCLES', 'EMAIL_PROVIDER', 'PAYMENT_PROVIDER', 'DEPLOYMENT_PROVIDER', 'RESEND_API_KEY', 'RESEND_FROM', 'RESEND_SENDER_DOMAIN', 'RESEND_WEBHOOK_SECRET', 'STRIPE_SECRET_KEY', 'STRIPE_WEBHOOK_SECRET', 'CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PAGES_PROJECT', 'OUTREACH_ENABLED', 'OUTREACH_REQUIRE_APPROVAL', 'OUTREACH_MAX_PER_DAY', 'OUTREACH_MAX_PER_DOMAIN_PER_DAY', 'OUTREACH_COOLDOWN_HOURS', 'OUTREACH_KILL_SWITCH', 'AUTOMATION_PAUSED', 'WORKSPACES_ROOT', 'PREVIEWS_ROOT', 'PRODUCTION_DEPLOYS_ROOT', 'PRICING_CURRENCY', 'PRICING_TIERS_JSON', 'FETCH_TIMEOUT_MS', 'FETCH_MAX_BYTES', 'EXEC_TIMEOUT_MS'] as const;

  const partialEnv: Record<string, string | undefined> = {};
  for (const key of schemaKeys) partialEnv[key] = env[key];

  let result: ReturnType<typeof envSchema.safeParse>;
  try {
    result = envSchema.safeParse(partialEnv);
  } catch (err) {
    // zod v4 propagates raw exceptions thrown inside .transform() —
    // normalize them into fail-closed ConfigErrors.
    issues.push(err instanceof Error ? err.message : String(err));
    throw new ConfigError(`configuration invalid (${issues.length} issue(s))`, issues);
  }
  if (!result.success) {
    for (const issue of result.error.issues) {
      issues.push(`${issue.path.join('.')}: ${issue.message}`);
    }
  }

  const envValues = (result.success ? result.data : {}) as Record<string, unknown>;

  // Secrets: fail closed. In test env, deterministic test values are allowed.
  const dashboardPassword = env['DASHBOARD_PASSWORD']?.trim();
  const sessionSecret = env['SESSION_SECRET']?.trim();
  if (nodeEnv !== 'test') {
    if (!dashboardPassword) issues.push('DASHBOARD_PASSWORD: required (dashboard authentication)');
    if (!sessionSecret) issues.push('SESSION_SECRET: required (session signing)');
  }

  // Provider credentials: fail closed when a real provider is selected
  // (Stage 9 of the production-integration phase). Never log secret values.
  const emailProvider = env['EMAIL_PROVIDER']?.trim() || 'mock';
  const paymentProvider = env['PAYMENT_PROVIDER']?.trim() || 'mock';
  const deploymentProvider = env['DEPLOYMENT_PROVIDER']?.trim() || 'local';

  if (emailProvider === 'resend') {
    if (!env['RESEND_API_KEY']?.trim()) issues.push('RESEND_API_KEY: required when EMAIL_PROVIDER=resend');
    if (!env['RESEND_FROM']?.trim()) issues.push('RESEND_FROM: required when EMAIL_PROVIDER=resend (verified sender identity)');
    if (!env['RESEND_WEBHOOK_SECRET']?.trim()) issues.push('RESEND_WEBHOOK_SECRET: required when EMAIL_PROVIDER=resend (svix webhook verification)');
  }
  if (paymentProvider === 'stripe') {
    if (!env['STRIPE_SECRET_KEY']?.trim()) issues.push('STRIPE_SECRET_KEY: required when PAYMENT_PROVIDER=stripe');
    if (!env['STRIPE_WEBHOOK_SECRET']?.trim()) issues.push('STRIPE_WEBHOOK_SECRET: required when PAYMENT_PROVIDER=stripe');
  }
  if (deploymentProvider === 'cloudflare') {
    for (const key of ['CLOUDFLARE_API_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_PAGES_PROJECT'] as const) {
      if (!env[key]?.trim()) issues.push(`${key}: required when DEPLOYMENT_PROVIDER=cloudflare`);
    }
  }
  // Stripe test/live key mode separation (when reliably identifiable).
  const stripeKey = env['STRIPE_SECRET_KEY']?.trim();
  if (stripeKey && !/^(sk_test_|sk_live_)/.test(stripeKey)) {
    issues.push('STRIPE_SECRET_KEY: unrecognized format (expected sk_test_… or sk_live_…)');
  }

  // Obvious placeholder secrets are rejected in production.
  if (nodeEnv === 'production') {
    const placeholders: Array<[string, string | undefined]> = [
      ['DASHBOARD_PASSWORD', dashboardPassword],
      ['SESSION_SECRET', sessionSecret],
    ];
    for (const [name, value] of placeholders) {
      if (value && /change-?me|placeholder|example|test/i.test(value)) {
        issues.push(`${name}: placeholder value rejected in NODE_ENV=production`);
      }
    }
  }

  if (issues.length > 0) {
    throw new ConfigError(`configuration invalid (${issues.length} issue(s))`, issues);
  }

  const cfg: AppConfig = {
    nodeEnv: nodeEnv as AppConfig['nodeEnv'],
    port: envValues['PORT'] as number,
    databasePath: (envValues['DATABASE_PATH'] as string) ?? './data/websalesai.sqlite',
    logLevel: (envValues['LOG_LEVEL'] as AppConfig['logLevel']) ?? 'info',
    publicBaseUrl: (envValues['PUBLIC_BASE_URL'] as string) ?? 'http://localhost:3000',

    dashboardPassword: dashboardPassword ?? 'test-dashboard-password',
    sessionSecret: sessionSecret ?? 'test-session-secret-do-not-use-in-production',

    ollama: {
      baseUrl: ((envValues['OLLAMA_BASE_URL'] as string) ?? 'https://ollama.com').replace(/\/+$/, ''),
      apiKey: env['OLLAMA_API_KEY']?.trim() || undefined,
      models: {
        researcher: env['OLLAMA_MODEL_RESEARCHER']?.trim() || (envValues['OLLAMA_MODEL'] as string) || 'glm-5.3-flash',
        sales: env['OLLAMA_MODEL_SALES']?.trim() || (envValues['OLLAMA_MODEL'] as string) || 'glm-5.3-flash',
        builder: env['OLLAMA_MODEL_BUILDER']?.trim() || (envValues['OLLAMA_MODEL'] as string) || 'glm-5.3-flash',
        reviewer: env['OLLAMA_MODEL_REVIEWER']?.trim() || (envValues['OLLAMA_MODEL'] as string) || 'glm-5.3-flash',
      },
      timeoutMs: (envValues['OLLAMA_TIMEOUT_MS'] as number) ?? 120000,
      maxRepairRetries: (envValues['OLLAMA_MAX_REPAIR_RETRIES'] as number) ?? 2,
      transportRetries: (envValues['OLLAMA_TRANSPORT_RETRIES'] as number) ?? 2,
    },

    reviewMaxCycles: (envValues['REVIEW_MAX_CYCLES'] as number) ?? 5,
    requirePaymentForProduction: (envValues['REQUIRE_PAYMENT_FOR_PRODUCTION'] as boolean) ?? true,

    emailProvider: (envValues['EMAIL_PROVIDER'] as AppConfig['emailProvider']) ?? 'mock',
    paymentProvider: (envValues['PAYMENT_PROVIDER'] as AppConfig['paymentProvider']) ?? 'mock',
    deploymentProvider: (envValues['DEPLOYMENT_PROVIDER'] as AppConfig['deploymentProvider']) ?? 'local',

    resend: {
      apiKey: env['RESEND_API_KEY']?.trim() || undefined,
      from: env['RESEND_FROM']?.trim() || undefined,
      senderDomain: env['RESEND_SENDER_DOMAIN']?.trim().toLowerCase() || undefined,
      webhookSecret: env['RESEND_WEBHOOK_SECRET']?.trim() || undefined,
    },

    stripe: {
      secretKey: env['STRIPE_SECRET_KEY']?.trim() || undefined,
      webhookSecret: env['STRIPE_WEBHOOK_SECRET']?.trim() || undefined,
    },

    cloudflare: {
      apiToken: env['CLOUDFLARE_API_TOKEN']?.trim() || undefined,
      accountId: env['CLOUDFLARE_ACCOUNT_ID']?.trim() || undefined,
      pagesProject: env['CLOUDFLARE_PAGES_PROJECT']?.trim() || undefined,
    },

    outreach: {
      enabled: (envValues['OUTREACH_ENABLED'] as boolean) ?? false,
      requireApproval: (envValues['OUTREACH_REQUIRE_APPROVAL'] as boolean) ?? true,
      maxPerDay: (envValues['OUTREACH_MAX_PER_DAY'] as number) ?? 20,
      maxPerDomainPerDay: (envValues['OUTREACH_MAX_PER_DOMAIN_PER_DAY'] as number) ?? 1,
      cooldownHours: (envValues['OUTREACH_COOLDOWN_HOURS'] as number) ?? 72,
      minScore: (envValues['OUTREACH_MIN_SCORE'] as number) ?? 60,
      killSwitchInitial: (envValues['OUTREACH_KILL_SWITCH'] as boolean) ?? false,
    },

    automationPausedInitial: (envValues['AUTOMATION_PAUSED'] as boolean) ?? false,

    paymentWebhookSecret: env['PAYMENT_WEBHOOK_SECRET']?.trim() || undefined,
    inboundEmailWebhookSecret: env['INBOUND_EMAIL_WEBHOOK_SECRET']?.trim() || undefined,

    workspacesRoot: (envValues['WORKSPACES_ROOT'] as string) ?? './workspaces',
    previewsRoot: (envValues['PREVIEWS_ROOT'] as string) ?? './previews',
    productionDeploysRoot: (envValues['PRODUCTION_DEPLOYS_ROOT'] as string) ?? './production-deploys',

    pricing: {
      currency: ((envValues['PRICING_CURRENCY'] as string) ?? 'USD').toUpperCase(),
      tiers: (envValues['PRICING_TIERS_JSON'] as Record<string, number>) ?? {},
    },

    fetchTimeoutMs: (envValues['FETCH_TIMEOUT_MS'] as number) ?? 20000,
    fetchMaxBytes: (envValues['FETCH_MAX_BYTES'] as number) ?? 2_000_000,
    execTimeoutMs: (envValues['EXEC_TIMEOUT_MS'] as number) ?? 120000,
  };

  return cfg;
}

export function loadConfigOrExit(env: NodeJS.ProcessEnv = process.env): AppConfig {
  try {
    return loadConfig(env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Intentionally print issues to stderr (not the logger) during boot failure.
      console.error('Configuration invalid:');
      for (const issue of err.issues) console.error(`  - ${issue}`);
      process.exit(1);
    }
    throw err;
  }
}
