import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface SuppressionEntryRecord {
  id: string;
  value: string;
  kind: 'email' | 'domain';
  reason: string;
  source: string;
  createdAt: string;
}

/**
 * Normalizes an email for matching: lowercases and strips '+tag'
 * subaddressing (user+news@x.com matches user@x.com).
 */
export function normalizeEmail(email: string): string {
  const cleaned = email.trim().toLowerCase();
  const at = cleaned.lastIndexOf('@');
  if (at <= 0) return cleaned;
  const local = cleaned.slice(0, at).split('+')[0]!;
  const domain = cleaned.slice(at + 1);
  return `${local}@${domain}`;
}

export class SuppressionRepository {
  constructor(private readonly db: Database) {}

  add(value: string, kind: 'email' | 'domain', reason: string, source: string): SuppressionEntryRecord {
    const normalized = kind === 'email' ? normalizeEmail(value) : normalizeDomain(value);
    const id = newId('sup');
    const at = nowIso();
    this.db.run(
      `INSERT INTO suppression_entries (id, value, kind, reason, source, created_at)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(value) DO NOTHING`,
      id,
      normalized,
      kind,
      reason,
      source,
      at,
    );
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM suppression_entries WHERE value = ?', normalized);
    if (!row) throw new Error('failed to persist suppression entry');
    return {
      id: String(row['id']),
      value: String(row['value']),
      kind: row['kind'] as 'email' | 'domain',
      reason: String(row['reason']),
      source: String(row['source']),
      createdAt: String(row['created_at']),
    };
  }

  isSuppressedEmail(email: string): boolean {
    const normalized = normalizeEmail(email);
    const direct = this.db.get<{ id: string }>("SELECT id FROM suppression_entries WHERE kind = 'email' AND value = ?", normalized);
    if (direct) return true;
    const domain = normalized.split('@')[1] ?? '';
    if (!domain) return false;
    return this.isSuppressedDomain(domain);
  }

  isSuppressedDomain(domain: string): boolean {
    const normalized = normalizeDomain(domain);
    if (!normalized) return false;
    const direct = this.db.get<{ id: string }>("SELECT id FROM suppression_entries WHERE kind = 'domain' AND value = ?", normalized);
    if (direct) return true;
    // Registrable-domain check: suppress example.co.uk? MVP checks exact domain
    // and one parent level (www.example.com -> example.com handled by
    // normalizeDomain stripping www.).
    const parts = normalized.split('.');
    if (parts.length > 2) {
      const parent = parts.slice(1).join('.');
      const parentRow = this.db.get<{ id: string }>("SELECT id FROM suppression_entries WHERE kind = 'domain' AND value = ?", parent);
      return parentRow !== undefined;
    }
    return false;
  }

  listAll(limit = 1000): SuppressionEntryRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM suppression_entries ORDER BY created_at DESC LIMIT ?', limit)
      .map((row) => ({
        id: String(row['id']),
        value: String(row['value']),
        kind: row['kind'] as 'email' | 'domain',
        reason: String(row['reason']),
        source: String(row['source']),
        createdAt: String(row['created_at']),
      }));
  }
}

export function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  d = d.replace(/^https?:\/\//, '').replace(/\/.*$/, '');
  if (d.startsWith('www.')) d = d.slice(4);
  return d;
}
