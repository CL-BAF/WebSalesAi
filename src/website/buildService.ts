import path from 'node:path';
import { ValidationError } from '../domain/errors.js';
import { Workspace } from './workspace.js';
import { BuilderAgent } from './builder.js';
import { runBuildChecks } from './checks.js';
import type { ResearcherDossier } from '../agents/schemas.js';
import type { RequirementRepository } from '../db/repositories/requirements.js';
import type { LeadRepository } from '../db/repositories/leads.js';
import type { WorkflowJobRepository } from '../db/repositories/workflowJobs.js';
import type { WebsiteProjectRepository, WebsiteProjectRecord } from '../db/repositories/websiteProjects.js';
import type { WorkflowEngine } from '../engine/workflowEngine.js';
import type { AuditEventRepository } from '../db/repositories/auditEvents.js';
import type { AppConfig } from '../config.js';
import type { Logger } from '../logger.js';

export interface BuildResult {
  project: WebsiteProjectRecord;
  workspace: Workspace;
  commitHash: string | null;
  filesWritten: string[];
  checks: ReturnType<typeof runBuildChecks>;
}

export interface WebsiteBuildServiceDeps {
  config: AppConfig;
  leads: LeadRepository;
  jobs: WorkflowJobRepository;
  requirements: RequirementRepository;
  projects: WebsiteProjectRepository;
  engine: WorkflowEngine;
  audit: AuditEventRepository;
  builder: BuilderAgent;
  log: Logger;
}

const SYSTEM = { actor: 'system', actorType: 'system' as const };

/**
 * Deterministic website build pipeline:
 * READY_TO_BUILD/REVISION_REQUIRED -> BUILDING -> generate -> write ->
 * git commit -> deterministic checks -> REVIEWING.
 *
 * The model's only influence is the CONTENT of generated files; paths are
 * schema-validated and containment-checked, and no model output ever reaches
 * the allowlisted command layer. Revision cycles are bounded by the caller
 * (Reviewer stage enforces REVIEW_MAX_CYCLES).
 */
export class WebsiteBuildService {
  constructor(private readonly deps: WebsiteBuildServiceDeps) {}

  workspaceFor(jobId: string): Workspace {
    return Workspace.open(path.resolve(this.deps.config.workspacesRoot), jobId, this.deps.config.execTimeoutMs);
  }

  async buildForJob(
    jobId: string,
    opts: { revisionCycle?: number; revisionFeedback?: string[] } = {},
  ): Promise<BuildResult> {
    const revisionCycle = opts.revisionCycle ?? 0;
    const { engine, jobs, leads, projects } = this.deps;
    const job = jobs.requireById(jobId);

    // Enter BUILDING from a legal entry state (deterministic pipeline).
    // FAILED is retryable (S6-3): BUILDING must never be a dead end.
    const current = jobs.requireById(jobId);
    if (current.state === 'FAILED') {
      this.deps.audit.append({ actor: 'system', actorType: 'system', action: 'stage.retried', jobId, details: { stage: 'build', failureReason: current.failureReason } });
    } else if (revisionCycle > 0) {
      if (current.state !== 'REVISION_REQUIRED') {
        throw new ValidationError(`revision build requires REVISION_REQUIRED state, job is ${current.state}`);
      }
    } else if (current.state !== 'READY_TO_BUILD') {
      throw new ValidationError(`build requires READY_TO_BUILD state, job is ${current.state}`);
    }
    engine.transition(jobId, 'BUILDING', { actor: 'system', actorType: 'system', reason: revisionCycle > 0 ? `revision cycle ${revisionCycle}` : current.state === 'FAILED' ? 'retry after failure' : 'initial build' });

    const lead = leads.requireLead(job.leadId);
    const business = leads.requireBusiness(lead.businessId);
    const dossier = lead.dossierJson ? (JSON.parse(lead.dossierJson) as ResearcherDossier) : null;
    const requirements = this.deps.requirements.listByJob(jobId);
    if (requirements.length === 0) {
      throw new ValidationError('cannot build a website with no requirements recorded');
    }

    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'generation.started',
      jobId,
      leadId: lead.id,
      details: { revisionCycle, requirements: requirements.length },
    });

    let written: string[];
    let commitHash: string | null;
    let generatedSiteTitle: string;
    let generatedModel: string;
    let generatedAttempts: number;
    try {
      const generated = await this.deps.builder.generate({
        jobId,
        businessName: business.name,
        industry: business.industry,
        dossier,
        requirements: requirements.map((r) => ({ category: r.category, title: r.title, detail: r.detail })),
        revisionFeedback: opts.revisionFeedback,
        revisionCycle,
      });
      generatedSiteTitle = generated.site.siteTitle;
      generatedModel = generated.model;
      generatedAttempts = generated.attempts;

      const workspace = this.workspaceFor(jobId);
      await workspace.create();
      written = [];
      for (const file of generated.site.files) {
        const res = workspace.writeFile(file.path, file.content);
        written.push(res.path);
      }
      commitHash = await workspace.commitRevision(
        revisionCycle > 0 ? `Revision ${revisionCycle}: ${generatedSiteTitle}` : `Initial build: ${generatedSiteTitle}`,
      );
    } catch (err) {
      // S6-3: builder failure must never leave BUILDING as a dead end.
      const message = err instanceof Error ? err.message : String(err);
      engine.transition(jobId, 'FAILED', { actor: 'system', actorType: 'system', reason: `build failed: ${message}` });
      this.deps.audit.append({
        actor: 'system',
        actorType: 'system',
        action: 'generation.failed',
        jobId,
        leadId: lead.id,
        details: { error: message, revisionCycle },
      });
      throw err;
    }

    this.deps.audit.append({
      actor: 'agent:builder',
      actorType: 'agent',
      action: 'files.generated',
      jobId,
      leadId: lead.id,
      details: { count: written.length, files: written, model: generatedModel, attempts: generatedAttempts, revisionCycle },
    });
    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'command.executed',
      jobId,
      leadId: lead.id,
      details: { command: 'git commit', purpose: 'record site revision', commitHash },
    });

    const workspace = this.workspaceFor(jobId);
    const checks = runBuildChecks(workspace.readAllFiles());
    this.deps.audit.append({
      actor: 'system',
      actorType: 'system',
      action: 'generation.completed',
      jobId,
      leadId: lead.id,
      details: {
        commitHash,
        files: written.length,
        checkFindings: checks.findings.length,
        checkHigh: checks.findings.filter((f) => f.severity === 'high').length,
      },
    });

    const project = projects.upsertForJob(jobId, workspace.root, revisionCycle > 0 ? 'revision_required' : 'generated');

    // Hand over to the Reviewer stage.
    engine.transition(jobId, 'REVIEWING', { actor: 'system', actorType: 'system', reason: 'build complete; review pending' });

    return { project, workspace, commitHash, filesWritten: written, checks };
  }
}
