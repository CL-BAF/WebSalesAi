import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

export interface SessionConfig {
  sessionSecret: string;
  dashboardPassword: string;
}

const SESSION_COOKIE = 'wsa_session';
const CSRF_COOKIE = 'wsa_csrf';
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12h

function sign(secret: string, value: string): string {
  return createHmac('sha256', secret).update(value).digest('hex');
}

function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function parseCookies(req: Request): Record<string, string> {
  const header = req.headers.cookie;
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const name = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (name) out[name] = decodeURIComponent(value);
  }
  return out;
}

export function verifyPassword(req: Request, cfg: SessionConfig): boolean {
  const provided = req.body?.['password'];
  return typeof provided === 'string' && provided.length > 0 && safeEqual(provided, cfg.dashboardPassword);
}

export function issueSession(res: Response, cfg: SessionConfig): void {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const value = `${expiresAt}.${sign(cfg.sessionSecret, String(expiresAt))}`;
  res.append('Set-Cookie',
    `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${cfg.sessionSecret === 'test-session-secret-do-not-use-in-production' ? '' : '; Secure'}`,
  );
}

export function clearSession(res: Response): void {
  res.append('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);
}

export function sessionMiddleware(cfg: SessionConfig) {
  return (req: Request & { sessionValid?: boolean }, res: Response, next: NextFunction): void => {
    const cookies = parseCookies(req);
    const raw = cookies[SESSION_COOKIE];
    if (raw) {
      const dot = raw.indexOf('.');
      if (dot > 0) {
        const expiresPart = raw.slice(0, dot);
        const sig = raw.slice(dot + 1);
        const expiresAt = Number(expiresPart);
        if (Number.isFinite(expiresAt) && expiresAt > Date.now() && safeEqual(sig, sign(cfg.sessionSecret, expiresPart))) {
          req.sessionValid = true;
        }
      }
    }
    next();
  };
}

export function requireSession(req: Request & { sessionValid?: boolean }, res: Response, next: NextFunction): void {
  if (req.sessionValid) return next();
  res.status(401).json({ error: 'authentication required' });
}

/** Issues (once per browser) and verifies the double-submit CSRF token. */
export function csrfMiddleware(req: Request & { sessionValid?: boolean }, res: Response, next: NextFunction): void {
  const cookies = parseCookies(req);
  const cookieToken = cookies[CSRF_COOKIE];
  const headerToken = req.headers['x-csrf-token'];
  if (typeof headerToken === 'string' && typeof cookieToken === 'string' && cookieToken.length > 0 && safeEqual(headerToken, cookieToken)) {
    return next();
  }
  res.status(403).json({ error: 'csrf token missing or invalid' });
}

export function issueCsrfToken(res: Response): string {
  const token = randomBytes(24).toString('hex');
  res.append('Set-Cookie', `${CSRF_COOKIE}=${token}; Path=/; SameSite=Strict`);
  return token;
}

