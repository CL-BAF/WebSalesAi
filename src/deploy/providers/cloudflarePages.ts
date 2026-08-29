import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';
import { runAllowlisted } from '../../website/exec.js';
import type { DeploymentProvider, DeploymentResult, DeploymentTarget } from '../deploymentProvider.js';

export interface CloudflarePagesOptions {
  apiToken: string;
  accountId: string;
  projectName: string;
  /** Branch name for preview deployments (unique <hash>.<project>.pages.dev URLs). */
  previewBranch?: string;
  /** Production branch â€” must match the project's configured production branch. */
  productionBranch?: string;
  workspacesRoot: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Production deployment provider: Cloudflare Pages Direct Upload via the
 * official wrangler CLI, invoked programmatically (no shell) through the
 * allowlisted exec layer.
 *
 * Docs (verified 2026-08): https://developers.cloudflare.com/pages/get-started/direct-upload/
 *  - `wrangler pages deploy <dir> --branch=<branch>` creates a deployment;
 *    non-production branches produce unique per-deployment preview URLs
 *    (<hash>.<project>.pages.dev); the production branch publishes to
 *    <project>.pages.dev.
 *  - Limits: 20,000 files / 25 MiB per file.
 *  - Auth: CLOUDFLARE_API_TOKEN (Pages:Edit) + CLOUDFLARE_ACCOUNT_ID via
 *    process environment â€” NEVER command-line arguments, NEVER logs/prompts.
 *
 * PREVIEW PRIVACY (honest wording): preview URLs are UNLISTED (unguessable
 * per-deployment hashes) but NOT access-controlled. They must not be
 * described as cryptographically private. (Cloudflare Access integration is
 * a future upgrade; Netlify-style password protection is not free.)
 *
 * The deployment is synchronous: a zero exit code means the deployment is
 * live and its URL is printed. Status is therefore derived from the command
 * result (getDeploymentStatus reports deployed for a captured URL).
 */
export class CloudflarePagesProvider implements DeploymentProvider {
  readonly name = 'cloudflare';
  private readonly previewBranch: string;
  private readonly productionBranch: string;

  constructor(private readonly opts: CloudflarePagesOptions) {
    this.previewBranch = opts.previewBranch ?? 'preview';
    this.productionBranch = opts.productionBranch ?? 'main';
  }

  async deploy(target: DeploymentTarget): Promise<DeploymentResult> {
    const branch = target.kind === 'preview' ? this.previewBranch : this.productionBranch;
    const timeoutMs = this.opts.timeoutMs ?? 300_000;
    const res = await runAllowlisted(
      {
        exe: 'wrangler',
        args: [
          'pages',
          'deploy',
          target.sourceDir,
          '--project-name',
          this.opts.projectName,
          '--branch',
          branch,
          '--commit-dirty=true',
        ],
        cwd: target.sourceDir,
        timeoutMs,
        env: {
          CLOUDFLARE_API_TOKEN: this.opts.apiToken,
          CLOUDFLARE_ACCOUNT_ID: this.opts.accountId,
          CI: 'true',
          WRANGLER_SEND_METRICS: 'false',
        },
      },
      path.resolve(this.opts.workspacesRoot),
    );

    if (res.timedOut) {
      throw new ValidationError(`cloudflare pages deploy timed out after ${timeoutMs}ms`);
    }
    if (res.code !== 0) {
      // stderr can contain project/account context but never the API token
      // (the token travels via env only). Trim to a safe length.
      throw new ValidationError(`cloudflare pages deploy failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`);
    }
    const url = this.extractDeploymentUrl(res.stdout);
    if (!url) {
      throw new ValidationError('cloudflare deploy succeeded but no deployment URL was found in output');
    }
    return { url, provider: this.name, providerReference: url };
  }

  async undeploy(target: DeploymentTarget): Promise<void> {
    // Cleanup is intentionally conservative: listing + deleting deployments
    // by URL is provider-side state we do not automate in this phase. The
    // owner manages preview cleanup in the Cloudflare dashboard; the
    // documented alternative (wrangler pages deployment delete) requires an
    // interactive deployment id that we do not parse from stdout yet.
    void target;
  }

  /** Extracts the per-deployment pages.dev URL from wrangler output. */
  private extractDeploymentUrl(stdout: string): string | null {
    // wrangler prints: "âœ¨ Deployment complete! Take a peek over at <url>"
    const peek = stdout.match(/Take a peek over at (https:\/\/[a-zA-Z0-9.-]+\.pages\.dev)/i);
    if (peek) return peek[1]!;
    const anyUrl = stdout.match(/https:\/\/[a-zA-Z0-9-]+\.[a-zA-Z0-9.-]*pages\.dev/i);
    return anyUrl ? anyUrl[0] : null;
  }
}

