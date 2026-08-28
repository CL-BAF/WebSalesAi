import { newId, nowIso } from '../../domain/ids.js';
import type { Database } from '../database.js';

export interface BusinessRecord {
  id: string;
  name: string;
  industry: string | null;
  description: string | null;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface LeadRecord {
  id: string;
  businessId: string;
  websiteUrl: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactSource: string | null;
  discoverySource: string;
  discoveryDetail: string | null;
  score: number | null;
  confidence: number | null;
  dossierJson: string | null;
  selectionReason: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CreateLeadInput {
  businessName: string;
  industry?: string;
  description?: string;
  source: string;
  websiteUrl?: string;
  contactName?: string;
  contactEmail?: string;
  contactSource?: string;
  discoveryDetail?: string;
  selectionReason: string;
}

function rowToBusiness(row: Record<string, unknown>): BusinessRecord {
  return {
    id: String(row['id']),
    name: String(row['name']),
    industry: (row['industry'] as string | null) ?? null,
    description: (row['description'] as string | null) ?? null,
    source: String(row['source']),
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

function rowToLead(row: Record<string, unknown>): LeadRecord {
  return {
    id: String(row['id']),
    businessId: String(row['business_id']),
    websiteUrl: (row['website_url'] as string | null) ?? null,
    contactName: (row['contact_name'] as string | null) ?? null,
    contactEmail: (row['contact_email'] as string | null) ?? null,
    contactSource: (row['contact_source'] as string | null) ?? null,
    discoverySource: String(row['discovery_source']),
    discoveryDetail: (row['discovery_detail'] as string | null) ?? null,
    score: row['score'] === null || row['score'] === undefined ? null : Number(row['score']),
    confidence: row['confidence'] === null || row['confidence'] === undefined ? null : Number(row['confidence']),
    dossierJson: (row['dossier_json'] as string | null) ?? null,
    selectionReason: (row['selection_reason'] as string | null) ?? null,
    createdAt: String(row['created_at']),
    updatedAt: String(row['updated_at']),
  };
}

export function normalizeWebsiteHost(url: string): string | null {
  try {
    const parsed = new URL(url.includes('://') ? url : `https://${url}`);
    let host = parsed.hostname.toLowerCase();
    if (host.startsWith('www.')) host = host.slice(4);
    return host || null;
  } catch {
    return null;
  }
}

export class LeadRepository {
  constructor(private readonly db: Database) {}

  createLead(input: CreateLeadInput, businessId?: string): { business: BusinessRecord; lead: LeadRecord } {
    const at = nowIso();
    return this.db.transaction(() => {
      const bizId = businessId ?? newId('biz');
      this.db.run(
        `INSERT INTO businesses (id, name, industry, description, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        bizId,
        input.businessName,
        input.industry ?? null,
        input.description ?? null,
        input.source,
        at,
        at,
      );
      const leadId = newId('lead');
      const websiteHost = input.websiteUrl ? normalizeWebsiteHost(input.websiteUrl) : null;
      this.db.run(
        `INSERT INTO leads (id, business_id, website_url, website_host, contact_name, contact_email, contact_source, discovery_source, discovery_detail, score, confidence, dossier_json, selection_reason, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
        leadId,
        bizId,
        input.websiteUrl ?? null,
        websiteHost,
        input.contactName ?? null,
        input.contactEmail ?? null,
        input.contactSource ?? null,
        input.source,
        input.discoveryDetail ?? null,
        input.selectionReason,
        at,
        at,
      );
      const business = this.requireBusiness(bizId);
      const lead = this.requireLead(leadId);
      return { business, lead };
    });
  }

  requireBusiness(id: string): BusinessRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM businesses WHERE id = ?', id);
    if (!row) throw new Error(`business not found: ${id}`);
    return rowToBusiness(row);
  }

  requireLead(id: string): LeadRecord {
    const row = this.db.get<Record<string, unknown>>('SELECT * FROM leads WHERE id = ?', id);
    if (!row) throw new Error(`lead not found: ${id}`);
    return rowToLead(row);
  }

  /** Deduplication is host-based: one lead per website host. */
  tryGetByWebsite(url: string): LeadRecord | undefined {
    const host = normalizeWebsiteHost(url);
    if (!host) return undefined;
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM leads WHERE website_host = ?',
      host,
    );
    return row ? rowToLead(row) : undefined;
  }

  tryGetByEmail(email: string): LeadRecord | undefined {
    const row = this.db.get<Record<string, unknown>>(
      'SELECT * FROM leads WHERE LOWER(contact_email) = LOWER(?)',
      email,
    );
    return row ? rowToLead(row) : undefined;
  }

  updateResearch(
    leadId: string,
    data: { score: number; confidence: number; dossierJson: string },
  ): void {
    this.db.run(
      'UPDATE leads SET score = ?, confidence = ?, dossier_json = ?, updated_at = ? WHERE id = ?',
      data.score,
      data.confidence,
      data.dossierJson,
      nowIso(),
      leadId,
    );
  }

  listAll(limit = 1000): LeadRecord[] {
    return this.db
      .all<Record<string, unknown>>('SELECT * FROM leads ORDER BY created_at DESC LIMIT ?', limit)
      .map(rowToLead);
  }
}
