import { test, describe, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CloudflarePagesProvider } from '../src/deploy/providers/cloudflarePages.js';
import { runAllowlisted } from '../src/website/exec.js';
import { ValidationError } from '../src/domain/errors.js';

describe('cloudflare pages provider — offline parts (A1)', () => {
  const cleanups: string[] = [];

  afterEach(() => {
    for (const dir of cleanups.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  test('extractDeploymentUrl prefers the per-deployment peek URL over the production alias', () => {
    const provider = new CloudflarePagesProvider({ apiToken: 't', accountId: 'a', projectName: 'proj', workspacesRoot: tmpdir() });
    const stdout = [
      'Upload complete.',
      '✨ Deployment complete! Take a peek over at https://b7c1d2ef.wsajobs.pages.dev',
      'Production: https://wsajobs.pages.dev',
    ].join('\n');
    assert.equal(provider.extractDeploymentUrl(stdout), 'https://b7c1d2ef.wsajobs.pages.dev', 'the peek URL (per-deployment hash) wins');
  });

  test('falls back to any pages.dev URL when the peek line is absent; null when none', () => {
    const provider = new CloudflarePagesProvider({ apiToken: 't', accountId: 'a', projectName: 'p', workspacesRoot: tmpdir() });
    assert.equal(provider.extractDeploymentUrl('Deployed https://deadbeef.proj.pages.dev ok'), 'https://deadbeef.proj.pages.dev');
    assert.equal(provider.extractDeploymentUrl('no deployment url in this output'), null);
  });

  test('wrangler arguments with shell metacharacters are rejected before spawn', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'wsa-cfargs-'));
    try {
      const provider = new CloudflarePagesProvider({
        apiToken: 't', accountId: 'a', projectName: 'p; rm -rf /', workspacesRoot: dir, timeoutMs: 1000,
      });
      const target = {
        sourceDir: dir, jobId: 'job_mock', kind: 'preview' as const, idempotencyKey: 'k',
      };
      // projectName flows into argv; a metacharacter must be rejected before spawn.
      await assert.rejects(() => provider.deploy({ sourceDir: dir, jobId: 'job_x', kind: 'preview', idempotencyKey: 'k' }), ValidationError);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test('cwd containment still applies to wrangler invocations', async () => {
    const container = mkdtempSync(path.join(tmpdir(), 'wsa-cfbase-'));
    cleanups.push(container);
    const outside = mkdtempSync(path.join(tmpdir(), 'wsa-cfelse-'));
    cleanups.push(outside);
    await assert.rejects(
      () => runAllowlisted(
        { exe: 'wrangler', args: ['pages', 'deploy', outside, '--project-name', 'p'], cwd: outside, timeoutMs: 1000 },
        container,
      ),
      /escapes the approved base directory/,
    );
  });
});