import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../../domain/errors.js';
import { isInsideDir } from '../../website/exec.js';
import type { DeploymentProvider, DeploymentResult, DeploymentTarget } from '../deploymentProvider.js';

/**
 * Local filesystem deployment provider (development MVP).
 * - Preview: copies the workspace into <previewsRoot>/<jobId>/
 * - Production: copies into <productionRoot>/<jobId>/ — gated by
 *   DeploymentService, not by this class.
 * URLs are relative to the configured public base URL and are served by the
 * dashboard's static file wiring.
 */
export class LocalDeploymentProvider implements DeploymentProvider {
  readonly name = 'local';

  constructor(
    private readonly kind: 'preview' | 'production',
    private readonly rootDir: string,
    private readonly publicBaseUrl: string,
  ) {}

  targetPath(jobId: string): string {
    const resolvedRoot = path.resolve(this.rootDir);
    const target = path.resolve(resolvedRoot, jobId);
    if (!isInsideDir(resolvedRoot, target)) {
      throw new ValidationError('deployment target escapes root');
    }
    return target;
  }

  async deploy(target: DeploymentTarget): Promise<DeploymentResult> {
    if (target.kind !== this.kind) {
      throw new ValidationError(`provider ${this.name} handles ${this.kind} deployments only`);
    }
    if (!existsSync(target.sourceDir)) {
      throw new ValidationError(`source directory does not exist: ${target.sourceDir}`);
    }
    const destination = this.targetPath(target.jobId);
    mkdirSync(path.dirname(destination), { recursive: true });
    if (existsSync(destination)) {
      rmSync(destination, { recursive: true, force: true });
    }
    cpSync(target.sourceDir, destination, {
      recursive: true,
      // Git metadata and workspace internals never get deployed.
      filter: (src) => !src.includes(`${path.sep}.git`) && path.basename(src) !== '.git',
    });
    // Basic sanity: the destination must contain an index.html.
    const hasIndex = existsSync(path.join(destination, 'index.html')) || this.hasHtmlRecursive(destination, 2);
    if (!hasIndex) {
      throw new ValidationError('deployed site contains no HTML entry point');
    }
    const url = `${this.publicBaseUrl.replace(/\/+$/, '')}/${this.kind}/${target.jobId}/`;
    return { url, provider: this.name, providerReference: destination };
  }

  async undeploy(target: DeploymentTarget): Promise<void> {
    const destination = this.targetPath(target.jobId);
    if (existsSync(destination)) {
      rmSync(destination, { recursive: true, force: true });
    }
  }

  private hasHtmlRecursive(dir: string, depth: number): boolean {
    if (depth < 0) return false;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isFile() && entry.name.endsWith('.html')) return true;
      if (entry.isDirectory() && this.hasHtmlRecursive(full, depth - 1)) return true;
    }
    return false;
  }
}
