import { pino, type Logger as PinoLogger } from 'pino';

const REDACT_KEY_PATTERN = /pass(word|wd)?|secret|token|api_?key|authorization|credential|cookie|session_?id/i;

export const REDACT_PATHS = [
  'OLLAMA_API_KEY',
  'SESSION_SECRET',
  'DASHBOARD_PASSWORD',
  'PAYMENT_WEBHOOK_SECRET',
  'INBOUND_EMAIL_WEBHOOK_SECRET',
  '*.password',
  '*.token',
  '*.apiKey',
  'req.headers.authorization',
  'req.headers.cookie',
];

export function redactSecrets<T>(value: T): T {
  return deepRedact(value, new Set()) as T;
}

function deepRedact(value: unknown, seen: Set<object>): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);
  if (Array.isArray(value)) {
    return value.map((item) => deepRedact(item, seen));
  }
  const out: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    if (REDACT_KEY_PATTERN.test(key) && typeof val !== 'object') {
      out[key] = '[REDACTED]';
    } else {
      out[key] = deepRedact(val, seen);
    }
  }
  return out;
}

export type Logger = PinoLogger;

export function createLogger(level: string): Logger {
  return pino(
    {
      level,
      redact: {
        paths: REDACT_PATHS,
        censor: '[REDACTED]',
      },
      base: undefined,
    },
  );
}
