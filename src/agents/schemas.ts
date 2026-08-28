import { z } from 'zod';

export const severityEnum = z.enum(['low', 'medium', 'high']);
export const sourceEnum = z.enum(['discovery', 'website', 'public_profile', 'customer_message', 'operator']);

export const verifiedFactSchema = z.object({
  claim: z.string().min(1).max(500),
  source: sourceEnum,
  sourceReference: z.string().max(500).optional(),
});

export const inferredObservationSchema = z.object({
  observation: z.string().min(1).max(500),
  confidence: z.number().min(0).max(1),
});

export const websiteProblemSchema = z.object({
  title: z.string().min(1).max(200),
  evidence: z.string().min(1).max(1000),
  severity: severityEnum,
});

/** Researcher output: structured lead dossier. */
export const researcherDossierSchema = z.object({
  businessName: z.string().min(1).max(200),
  websitePresent: z.boolean(),
  summary: z.string().min(1).max(4000),
  verifiedFacts: z.array(verifiedFactSchema).max(50),
  inferredObservations: z.array(inferredObservationSchema).max(50),
  identifiedProblems: z.array(websiteProblemSchema).max(30),
  score: z.number().int().min(0).max(100),
  confidence: z.number().min(0).max(1),
  recommendForOutreach: z.boolean(),
  rejectionReasons: z.array(z.string().max(300)).max(10).default([]),
});
export type ResearcherDossier = z.infer<typeof researcherDossierSchema>;

/** Sales output: outbound outreach draft. */
export const outreachDraftSchema = z.object({
  subject: z.string().min(1).max(200),
  body: z.string().min(1).max(5000),
  personalizationNotes: z.array(z.string().max(300)).max(10).default([]),
});
export type OutreachDraft = z.infer<typeof outreachDraftSchema>;

export const replyIntentEnum = z.enum(['positive', 'negative', 'ambiguous', 'question', 'opt_out']);
export const extractedRequirementSchema = z.object({
  category: z.enum(['pages', 'design', 'content', 'functionality', 'integration', 'branding', 'other']),
  title: z.string().min(1).max(200),
  detail: z.string().min(1).max(2000),
});

/** Sales output: classification of an inbound customer reply. */
export const replyClassificationSchema = z.object({
  intent: replyIntentEnum,
  confidence: z.number().min(0).max(1),
  summary: z.string().min(1).max(2000),
  extractedRequirements: z.array(extractedRequirementSchema).max(50).default([]),
  suggestedReply: z.string().max(5000).optional(),
  needsHumanReview: z.boolean().default(false),
});
export type ReplyClassification = z.infer<typeof replyClassificationSchema>;

/**
 * Shared safe-relative-path validator for any model-supplied path.
 * Enforced again at filesystem write time (resolved-path containment check) —
 * this schema is the first boundary, not the only one.
 */
export const safeRelativePath = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 _\-./]*$/, 'path must be relative and use safe characters')
  .refine((p) => !p.includes('..') && !p.startsWith('/') && !p.includes('\\'), 'path traversal is not allowed')
  .refine(
    (p) =>
      p
        .split('/')
        .every(
          (seg) =>
            seg.length > 0 &&
            !/[. ]$/.test(seg) &&
            !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])([. ][^.]*)?$/i.test(seg),
        ),
    'unsafe path segment',
  );

export const generatedFileSchema = z.object({
  path: safeRelativePath,
  content: z.string().max(200_000),
  purpose: z.string().max(300).default(''),
});
export type GeneratedFile = z.infer<typeof generatedFileSchema>;

export const builderSiteSchema = z.object({
  siteTitle: z.string().min(1).max(200),
  pages: z.array(z.object({ path: safeRelativePath, title: z.string().min(1).max(200) })).min(1).max(30),
  files: z.array(generatedFileSchema).min(1).max(200),
  buildNotes: z.string().max(2000).default(''),
});
export type BuilderSite = z.infer<typeof builderSiteSchema>;

export const findingCategoryEnum = z.enum([
  'requirements_coverage',
  'build',
  'runtime_error',
  'responsive',
  'navigation',
  'links',
  'forms',
  'accessibility',
  'spelling',
  'hallucinated_content',
  'security',
  'seo',
  'performance',
  'broken_ui',
  'placeholder_content',
  'exposed_secrets',
  'other',
]);

/** Reviewer output: machine-readable verdict. */
export const reviewerVerdictSchema = z.object({
  verdict: z.enum(['PASS', 'CHANGES_REQUIRED']),
  summary: z.string().min(1).max(4000),
  findings: z
    .array(
      z.object({
        category: findingCategoryEnum,
        severity: severityEnum,
        description: z.string().min(1).max(1000),
        file: z.string().max(200).optional(),
      }),
    )
    .max(100),
});
export type ReviewerVerdict = z.infer<typeof reviewerVerdictSchema>;
