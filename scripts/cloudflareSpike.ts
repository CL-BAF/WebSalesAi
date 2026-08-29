/**
 * A1 FEASIBILITY SPIKE — Cloudflare Pages Direct Upload via the official
 * wrangler CLI, invoked exactly like the production adapter does
 * (programmatic spawn through the allowlisted exec layer, no shell).
 *
 * Env-gated: requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID +
 * CLOUDFLARE_PAGES_PROJECT (a THROWAWAY project) and
 * PRODUCTION_EXTERNAL_ACTIONS_ENABLED=true. Without credentials this exits
 * loudly with SKIPPED — skipped is never reported as proof.
 *
 * Run:  npx tsx scripts/cloudflareSpike.ts
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { CloudflarePagesProvider } from '../src/deploy/providers/cloudflarePages.js';

async function runSpike(): Promise<number> {
  const token = process.env['CLOUDFLARE_API_TOKEN'];
  const accountId = process.env['CLOUDFLARE_ACCOUNT_ID'];
  const project = process.env['CLOUDFLARE_PAGES_PROJECT'];
  const gate = process.env['PRODUCTION_EXTERNAL_ACTIONS_ENABLED'];

  if (!token || !accountId || !project) {
    console.log('[A1 SPIKE] SKIPPED — CLOUDFLARE_API_TOKEN / CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_PAGES_PROJECT not set.');
    console.log('[A1 SPIKE] SKIPPED is NOT a pass: live wrangler upload flow remains unverified.');
    return 2;
  }
  if (process.env['PRODUCTION_EXTERNAL_ACTIONS_ENABLED'] !== 'true') {
    console.log('[A1 SPIKE] SKIPPED — set PRODUCTION_EXTERNAL_ACTIONS_ENABLED=true to run against the real provider.');
    process.exit(2);
  }
  void project;

  const dir = mkdtempSync(path.join(tmpdir(), 'wsa-spike-'));
  const { writeFileSync } = await import('node:fs');
  writeFileSync(path.join(dir, 'index.html'), '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>WSA spike</title></head><body><h1>WebSalesAi A1 spike</h1><p>Throwaway deployment — safe to delete.</p></body></html>');
  try {
    const { CloudflarePagesProvider } = await import('../src/deploy/providers/cloudflarePages.js');
    const provider = new CloudflarePagesProvider({
      apiToken: token,
      accountId: accountId ?? '',
      projectName: project,
      previewBranch: 'spike',
      workspacesRoot: dir,
      timeoutMs: 300_000,
    });
    console.log('[A1] deploying throwaway preview via the production adapter…');
    const result = await provider.deploy({
      sourceDir: dir,
      jobId: 'job_spike-00000000-0000-4000-8000-000000000000',
      kind: 'preview',
      idempotencyKey: `spike:${Date.now()}`,
    });
    console.log(`[A1 SPIKE] PASS — deployed ${result.url}`);
    console.log('Adapter contract verified against the live wrangler flow.');
    return 0;
  } catch (err) {
    console.error(`A1 SPIKE FAILED — ${err instanceof Error ? err.message : String(err)}`);
    console.error('Revisit the wrangler flow (or the fallback documented in A1) before live sign-off.');
    return 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

process.exitCode = await runSpike();