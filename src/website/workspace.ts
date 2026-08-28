import { mkdirSync, writeFileSync, readFileSync, existsSync, lstatSync, rmSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { ValidationError } from '../domain/errors.js';
import { safeRelativePath } from '../agents/schemas.js';
import { isInsideDir, runAllowlisted } from './exec.js';

export interface WrittenFile {
  path: string;
  bytes: number;
}

/**
 * Isolated per-job website workspace. One customer job can never read or
 * modify another job's files:
 *  - workspaces live at <root>/<jobId>/ with jobId format-validated;
 *  - every path is schema-validated (safeRelativePath) AND resolved-path
 *    contained inside the workspace before any write;
 *  - symlinks are refused (lstat check) so a planted link cannot redirect
 *    writes outside the workspace;
 *  - git is used per site for traceable revisions (allowlisted exec only).
 */
export class Workspace {
  private constructor(
    readonly root: string,
    readonly baseDir: string,
    private readonly execTimeoutMs: number,
  ) {}

  static readonly JOB_ID_PATTERN = /^job_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

  static open(baseDir: string, jobId: string, execTimeoutMs: number): Workspace {
    if (!Workspace.JOB_ID_PATTERN.test(jobId)) {
      throw new ValidationError(`refusing to open workspace for malformed job id: ${jobId}`);
    }
    const resolvedBase = path.resolve(baseDir);
    const root = path.join(resolvedBase, jobId);
    return new Workspace(root, resolvedBase, execTimeoutMs);
  }

  exists(): boolean {
    return existsSync(this.root);
  }

  async create(): Promise<void> {
    if (this.exists()) return;
    mkdirSync(this.root, { recursive: true });
    await this.git(['init'], true);
    await this.git(['config', 'user.email', 'builder@websalesai.local'], true);
    await this.git(['config', 'user.name', 'WebSalesAi Builder'], true);
  }

  destroy(): void {
    if (this.exists()) {
      rmSync(this.root, { recursive: true, force: true });
    }
  }

  /** Writes a file after schema + containment + symlink-safety checks. */
  writeFile(relPath: string, content: string): WrittenFile {
    const pathCheck = safeRelativePath.safeParse(relPath);
    if (!pathCheck.success) {
      throw new ValidationError(`unsafe generated path "${relPath}"`);
    }
    const target = path.resolve(this.root, relPath);
    if (!isInsideDir(this.root, target)) {
      throw new ValidationError(`resolved path escapes workspace: ${relPath}`);
    }
    // Refuse to write through any pre-existing symlink/junction chain.
    // lstat (not stat): junctions on Windows must be detected, not followed.
    let cursor = path.dirname(target);
    while (isInsideDir(this.root, cursor) && cursor !== path.parse(cursor).root) {
      if (existsSync(cursor) && lstatSync(cursor).isSymbolicLink()) {
        throw new ValidationError(`symlink in workspace path is not allowed: ${relPath}`);
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) break;
      cursor = parent;
    }
    if (existsSync(target) && lstatSync(target).isSymbolicLink()) {
      throw new ValidationError(`refusing to overwrite a symlink: ${relPath}`);
    }
    if (existsSync(target) && lstatSync(target).isDirectory()) {
      throw new ValidationError(`refusing to write over a directory: ${relPath}`);
    }
    mkdirSync(path.dirname(target), { recursive: true });
    const bytes = Buffer.byteLength(content, 'utf8');
    writeFileSync(target, content, 'utf8');
    return { path: relPath, bytes };
  }

  readFile(relPath: string): string | undefined {
    const target = path.resolve(this.root, relPath);
    if (!isInsideDir(this.root, target)) return undefined;
    if (!existsSync(target) || lstatSync(target).isDirectory()) return undefined;
    return readFileSync(target, 'utf8');
  }

  /** Relative paths of all files in the workspace (git metadata excluded). */
  listFiles(): string[] {
    if (!this.exists()) return [];
    const out: string[] = [];
    const walk = (dir: string, prefix: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          walk(path.join(dir, entry.name), rel);
        } else if (entry.isFile()) {
          out.push(rel);
        }
      }
    };
    walk(this.root, '');
    return out.sort();
  }

  readAllFiles(): Map<string, string> {
    const map = new Map<string, string>();
    for (const rel of this.listFiles()) {
      const content = this.readFile(rel);
      if (content !== undefined) map.set(rel, content);
    }
    return map;
  }

  /** Commits current state; returns the commit hash. */
  async commitRevision(message: string): Promise<string | null> {
    await this.git(['add', '-A'], true);
    await this.git(['commit', '-m', message.slice(0, 200), '--allow-empty'], false);
    const hash = await this.git(['rev-parse', 'HEAD'], false);
    const match = hash.stdout.trim().match(/^[0-9a-f]{7,40}/);
    return match ? match[0] : null;
  }

  /**
   * Runs git inside the workspace (allowlisted exec layer).
   * `allowFailure` marks commands that may legitimately no-op/fail
   * (init on an existing repo, config re-application, add with no changes).
   */
  private async git(args: string[], allowFailure: boolean): Promise<{ code: number; stdout: string; stderr: string }> {
    const res = await runAllowlisted({ exe: 'git', args, cwd: this.root, timeoutMs: this.execTimeoutMs }, this.baseDir);
    if (res.code !== 0 && !allowFailure) {
      throw new ValidationError(`git ${args[0]} failed (exit ${res.code}): ${res.stderr.slice(0, 300)}`);
    }
    return res;
  }
}
