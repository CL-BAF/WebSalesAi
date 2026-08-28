import { AgentFramework } from '../agents/framework.js';
import { wrapUntrusted } from '../agents/injection.js';
import { researcherDossierSchema, type ResearcherDossier } from '../agents/schemas.js';
import type { OllamaUsage } from '../agents/ollamaClient.js';

export interface ResearchInput {
  jobId?: string;
  businessName: string;
  industry?: string | null;
  discoverySource: string;
  discoveryDetail?: string | null;
  websiteUrl?: string | null;
  /** Pre-fetched public website text (untrusted) — supplied by the caller. */
  websiteText?: string | null;
  contactEmail?: string | null;
}

export interface ResearchResult {
  dossier: ResearcherDossier;
  usage: OllamaUsage;
  model: string;
  attempts: number;
}

/**
 * Researcher role wrapper. The researcher never invents business facts: the
 * prompt demands verified-fact sourcing, separates inference from fact, and
 * the zod schema enforces the structure. All external content is passed as
 * wrapped untrusted data.
 */
export class ResearcherAgent {
  constructor(private readonly framework: AgentFramework) {}

  async research(input: ResearchInput): Promise<ResearchResult> {
    const sections: string[] = [
      'Analyse this business lead for a website-improvement service. Assess whether the business would plausibly benefit from a new or improved website and whether outreach is appropriate.',
      'Rules:',
      '- Base verifiedFacts ONLY on the provided discovery/source material and website content.',
      '- NEVER invent employee names, email addresses, services, prices, opening hours, testimonials, addresses or any business fact not present in the material.',
      '- Separate inference into inferredObservations with confidence values.',
      '- Identify concrete, genuine website problems only when evidence exists.',
      '- Score lead quality 0-100 and your confidence 0-1.',
    ];

    sections.push(wrapUntrusted('discovery-source', [
      `source system: ${input.discoverySource}`,
      `business name: ${input.businessName}`,
      input.industry ? `industry: ${input.industry}` : null,
      input.contactEmail ? `public contact email on record: ${input.contactEmail}` : null,
      input.discoveryDetail ? `source notes: ${input.discoveryDetail}` : null,
    ].filter(Boolean).join('\n')));

    sections.push(
      input.websiteText
        ? wrapUntrusted('public-website-content', input.websiteText)
        : 'NO_PUBLIC_WEBSITE_CONTENT: the business has no reachable public website (this is itself a research finding).',
    );
    if (input.websiteUrl) {
      sections.push(`website URL on record: ${input.websiteUrl}`);
    }

    const res = await this.framework.runStructured({
      role: 'researcher',
      purpose: 'research:lead_dossier',
      jobId: input.jobId,
      instruction: 'Produce the lead dossier JSON. Only the JSON document, nothing else.',
      task: sections.join('\n\n'),
      schema: researcherDossierSchema,
      temperature: 0.2,
    });
    return { dossier: res.output, usage: res.usage, model: res.model, attempts: res.attempts };
  }
}
