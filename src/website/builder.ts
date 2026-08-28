import { AgentFramework } from '../agents/framework.js';
import { wrapUntrusted } from '../agents/injection.js';
import { builderSiteSchema, type BuilderSite, type ResearcherDossier } from '../agents/schemas.js';

export interface BuilderInput {
  jobId?: string;
  businessName: string;
  industry?: string | null;
  dossier: ResearcherDossier | null;
  requirements: Array<{ category: string; title: string; detail: string }>;
  /** Feedback from the previous review cycle (REVISION_REQUIRED). */
  revisionFeedback?: string[];
  revisionCycle: number;
}

/**
 * Website Builder role wrapper. Generates a complete static site
 * (HTML/CSS/JS) from verified requirements. Hard prompt rules prohibit
 * fabricated testimonials/stats/staff, placeholder content, external
 * scripts, and any secrets. Output is schema-validated (paths + sizes).
 */
export class BuilderAgent {
  constructor(private readonly framework: AgentFramework) {}

  async generate(input: BuilderInput): Promise<{ site: BuilderSite; model: string; attempts: number }> {
    const isRevision = input.revisionCycle > 0 && (input.revisionFeedback?.length ?? 0) > 0;
    const rules = [
      'Generate a complete, production-quality STATIC website (HTML + CSS + vanilla JS only, no build step, no external dependencies).',
      'HARD RULES:',
      '- index.html at the root is REQUIRED. All internal links/asset paths must be relative (e.g. "about.html", "css/site.css") and must resolve to files you include.',
      '- Content must come ONLY from the verified material below. NEVER invent testimonials, reviews, statistics, certifications, staff names, addresses, phone numbers, opening hours, awards or prices.',
      '- If verified material does not fill a section, omit the section or write neutral connective text. Empty filler is a review failure.',
      '- No lorem ipsum, no TODO/FIXME, no "example", no placeholder images (use CSS-only visuals or plain colour blocks).',
      '- Responsive layout (mobile-first, viewport meta), semantic HTML, alt text on images, label every form control, visible focus states, sufficient contrast.',
      '- No external scripts/fonts/iframes (no http(s):// resource references in src/href attributes except in-page anchors).',
      '- No API keys, tokens, secrets, or credentials anywhere in the output.',
      '- Forms (only if explicitly required): action="#", method="post", client-side validation, and a visible note that submission is handled by the business.',
      '- Keep every file under 200KB; prefer one shared CSS file.',
    ];

    const sections: Array<string | null> = [
      `Business: ${input.businessName}`,
      input.industry ? `Industry: ${input.industry}` : null,
      input.dossier
        ? wrapUntrusted('verified-research-dossier', JSON.stringify(input.dossier))
        : 'No research dossier available — rely only on the requirements below.',
      'CUSTOMER REQUIREMENTS (authoritative):',
      wrapUntrusted(
        'requirements',
        input.requirements.map((r, i) => `${i + 1}. [${r.category}] ${r.title}: ${r.detail}`).join('\n') || '(none provided)',
      ),
    ];

    if (isRevision) {
      sections.push(
        'REVIEWER FEEDBACK THAT MUST BE ADDRESSED IN FULL:',
        wrapUntrusted('revision-feedback', (input.revisionFeedback ?? []).join('\n')),
        `This is revision cycle ${input.revisionCycle}.`,
      );
    }

    const res = await this.framework.runStructured({
      role: 'builder',
      purpose: isRevision ? 'builder:revise_site' : 'builder:generate_site',
      jobId: input.jobId,
      instruction: rules.join('\n'),
      task: sections.filter(Boolean).join('\n\n'),
      schema: builderSiteSchema,
      temperature: 0.3,
    });
    return { site: res.output, model: res.model, attempts: res.attempts };
  }
}
