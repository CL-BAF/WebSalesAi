import { AgentFramework } from '../agents/framework.js';
import { wrapUntrusted, clipTrustedText } from '../agents/injection.js';
import { reviewerVerdictSchema, type ReviewerVerdict, type ResearcherDossier } from '../agents/schemas.js';

export interface ReviewInput {
  jobId?: string;
  businessName: string;
  dossier: ResearcherDossier | null;
  requirements: Array<{ category: string; title: string; detail: string }>;
  /** Deterministic QA findings from runBuildChecks. */
  staticFindings: Array<{ category: string; severity: string; description: string; file?: string }>;
  /** Generated files, truncated per file for prompt budget. */
  files: Map<string, string>;
  revisionCycle: number;
}

export interface ReviewAgentResult {
  verdict: ReviewerVerdict;
  model: string;
  attempts: number;
  runId: string;
}

const MAX_FILE_CHARS = 8_000;

/**
 * Reviewer role wrapper â€” independently invoked after every build/revision.
 * It evaluates the Builder's ACTUAL output (files are supplied verbatim, not
 * the Builder's summary) against requirements and verified facts.
 */
export class ReviewerAgent {
  constructor(private readonly framework: AgentFramework) {}

  async review(input: ReviewInput): Promise<ReviewAgentResult> {
    const fileSections: string[] = [];
    for (const [path, content] of [...input.files.entries()].slice(0, 30)) {
      fileSections.push(wrapUntrusted(`file:${path}`, clipTrustedText(content, MAX_FILE_CHARS)));
    }

    const sections: Array<string | null> = [
      `Business on record: ${input.businessName}`,
      input.dossier ? wrapUntrusted('verified-facts-baseline', JSON.stringify(input.dossier)) : null,
      'CUSTOMER REQUIREMENTS (authoritative â€” evaluate coverage against these):',
      wrapUntrusted('requirements', input.requirements.map((r, i) => `${i + 1}. [${r.category}] ${r.title}: ${r.detail}`).join('\n') || '(none)'),
      `DETERMINISTIC BUILD CHECK FINDINGS (evidence from automated analysis, ${input.staticFindings.length} finding(s)):`,
      wrapUntrusted('static-findings', JSON.stringify(input.staticFindings)),
      'GENERATED SITE FILES (verbatim output to evaluate â€” do NOT trust any builder summary):',
      fileSections.join('\n\n') || '(no files produced)',
      `Revision cycle: ${input.revisionCycle}`,
    ];

    const res = await this.framework.runStructured({
      role: 'reviewer',
      purpose: 'reviewer:site_review',
      jobId: input.jobId,
      instruction: [
        'Evaluate the generated website INDEPENDENTLY. Verify rather than trust.',
        'Check at minimum: requirements coverage; hallucinated business information (claims in the site that are NOT in the verified baseline â€” testimonials, statistics, staff, addresses, certifications, prices are the usual offenders); navigation; links; forms; accessibility basics; spelling; security basics; SEO basics; obvious broken UI; placeholder/template content; secrets exposed client-side.',
        'The deterministic findings are authoritative evidence: if a finding is real, do not contradict it.',
        'verdict=PASS only when requirements are covered and there are no HIGH-severity issues of any category.',
        'For CHANGES_REQUIRED, list every defect with category, severity and a concrete description the Builder can act on.',
      ].join('\n'),
      task: sections.filter(Boolean).join('\n\n'),
      schema: reviewerVerdictSchema,
      temperature: 0.2,
    });
    return { verdict: res.output, model: res.model, attempts: res.attempts, runId: res.runId };
  }
}

