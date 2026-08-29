import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { ValidationError } from '../domain/errors.js';

export type AllowedExe = 'git' | 'node' | 'wrangler';

export interface AllowlistedCommand {
  exe: AllowedExe;
  args: string[];
  cwd: string;
  timeoutMs: number;
  /**
   * Extra environment variables (e.g. CLOUDFLARE_API_TOKEN). ONLY accepted
   * for the wrangler allowlist entry, never logged, never placed in argv.
   */
  env?: Record<string, string>;
}

export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Git subcommands the platform may ever execute inside a workspace. */
const GIT_SUBCOMMANDS = new Set(['init', 'add', 'commit', 'status', 'log', 'diff', 'rev-parse', 'config']);

/** Wrangler subcommands + strict argument shapes (Cloudflare Pages deploys). */
const WRANGLER_SUBCOMMANDS = new Set(['pages']);
const WRANGLER_PAGES_ACTIONS = new Set(['deploy', 'deployment']);
const WRANGLER_ARG_PATTERN = /^[A-Za-z0-9_@%+=:,./-]+$/;

let cachedWranglerCli: string | undefined;

function resolveWranglerCli(): string {
  if (cachedWranglerCli) return cachedWranglerCli;
  const requireFromApp = createRequire(path.join(process.cwd(), 'package.json'));
  // wrangler's documented programmatic entry (bin target).
  cachedWranglerCli = requireFromApp.resolve('wrangler/wrangler-dist/cli.js');
  return cachedWranglerCli;
}

export function isInsideDir(dir: string, candidate: string): boolean {
  const rel = path.relative(dir, candidate);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Allowlisted command execution for website build tooling.
 *
 * Hard guarantees:
 *  - only 'git' and 'node' may run (no shell, spawn shell:false);
 *  - git is restricted to a fixed subcommand allowlist;
 *  - node is restricted to '--version' (no arbitrary script execution);
 *  - cwd MUST be inside the approved base directory (containment enforced);
 *  - bounded time and output; args are plain strings, never shell-interpreted.
 *
 * Model output NEVER reaches this layer directly: callers construct fixed
 * argument shapes; file content is the only model-controlled input and it is
 * written to the workspace filesystem, never passed as a command argument.
 */
export async function runAllowlisted(cmd: AllowlistedCommand, baseDir: string): Promise<CommandResult> {
  if (cmd.exe !== 'git' && cmd.exe !== 'node' && cmd.exe !== 'wrangler') {
    throw new ValidationError(`executable not allowlisted: ${cmd.exe}`);
  }
  if (!isInsideDir(baseDir, path.resolve(cmd.cwd))) {
    throw new ValidationError('command cwd escapes the approved base directory');
  }
  if (cmd.exe === 'node') {
    if (cmd.args.length !== 1 || cmd.args[0] !== '--version') {
      throw new ValidationError('node is only allowlisted for --version');
    }
  }
  if (cmd.exe === 'git') {
    const sub = cmd.args[0];
    if (!sub || !GIT_SUBCOMMANDS.has(sub)) {
      throw new ValidationError(`git subcommand not allowlisted: ${String(sub)}`);
    }
    for (const arg of cmd.args) {
      if (/^-c$|^--config|^--upload-pack|^--exec|^--ext|^--git-dir|^--work-tree|^--namespace|^--output|^--filter/.test(arg)) {
        throw new ValidationError(`potentially dangerous git argument: ${arg}`);
      }
    }
    if (sub === 'config') {
      // Only repo-local user identity is ever configured.
      const key = cmd.args[1];
      if (!key || !/^user\.(email|name)$/.test(key)) {
        throw new ValidationError(`git config key not allowlisted: ${String(key)}`);
      }
    }
  }
  if (cmd.exe === 'wrangler') {
    if (cmd.args[0] !== 'pages' || !WRANGLER_PAGES_ACTIONS.has(cmd.args[1] ?? '')) {
      throw new ValidationError(`wrangler pages action not allowlisted: ${cmd.args.slice(0, 2).join(' ')}`);
    }
    if (cmd.args[1] === 'deploy' && cmd.args[2] !== 'deploy' && !cmd.args[2]) {
      throw new ValidationError('wrangler pages deploy requires a directory argument');
    }
    for (const arg of cmd.args) {
      if (!WRANGLER_ARG_PATTERN.test(arg)) {
        throw new ValidationError(`wrangler argument rejected: ${arg}`);
      }
    }
  }

  // wrangler runs as `node <wrangler-cli> …` — the CLI itself is the
  // only script node may execute, and args are validated above.
  const exe = cmd.exe === 'wrangler' ? process.execPath : cmd.exe;
  const argv = cmd.exe === 'wrangler' ? [resolveWranglerCli(), ...cmd.args] : cmd.args;
  const childEnv = cmd.exe === 'wrangler' ? { ...process.env, ...cmd.env } : undefined;

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(exe, argv, {
      cwd: cmd.cwd,
      shell: false,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...(childEnv ? { env: childEnv } : {}),
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill('SIGKILL');
    }, cmd.timeoutMs);
    child.stdout.on('data', (d: Buffer) => {
      if (stdout.length < 1_000_000) stdout += d.toString('utf8');
    });
    child.stderr.on('data', (d: Buffer) => {
      if (stderr.length < 1_000_000) stderr += d.toString('utf8');
    });
    child.on('error', (err) => {
      clearTimeout(timer);
      reject(new ValidationError(`failed to start ${cmd.exe}: ${err.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr, timedOut });
    });
  });
}
