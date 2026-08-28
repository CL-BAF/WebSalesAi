import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, mkdirSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Workspace } from '../src/website/workspace.js';
import { runAllowlisted, isInsideDir } from '../src/website/exec.js';
import { ValidationError } from '../src/domain/errors.js';

let base: string;
let workspace: Workspace;
const jobId = 'job_a1b2c3d4-e5f6-4a1b-8c2d-1234567890ab';

beforeEach(async () => {
  base = mkdtempSync(path.join(tmpdir(), 'wsa-ws-'));
  workspace = Workspace.open(base, jobId, 10000);
  await workspace.create();
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('workspace isolation', () => {
  test('creates isolated directory and git repo', async () => {
    assert.ok(existsSync(path.join(base, jobId)));
    assert.ok(existsSync(path.join(base, jobId, '.git')));
    const hash = await workspace.commitRevision('test commit');
    assert.ok(hash && /^[0-9a-f]{7,40}$/.test(hash));
  });

  test('refuses malformed job ids', () => {
    assert.throws(() => Workspace.open(base, '../evil', 1000), ValidationError);
    assert.throws(() => Workspace.open(base, 'job_short', 1000), ValidationError);
    assert.throws(() => Workspace.open(base, 'job_' + 'a'.repeat(40), 1000), ValidationError);
  });

  test('writeFile containment: traversal and absolute paths rejected', () => {
    for (const p of ['../escape.html', '/abs.html', 'a\\b.html', 'sub/../../out.html', 'con.html']) {
      assert.throws(() => workspace.writeFile(p, 'x'), ValidationError, p);
    }
    assert.throws(() => workspace.writeFile('..\\windows.html', 'x'), ValidationError);
  });

  test('symlink chain cannot redirect writes', (t) => {
    const outside = mkdtempSync(path.join(tmpdir(), 'wsa-out-'));
    try {
      mkdirSync(path.join(workspace.root, 'sub'));
      try {
        symlinkSync(outside, path.join(workspace.root, 'sub', 'link'), 'junction');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'EPERM' || code === 'ENOENT') {
          t.skip('symlink creation requires privileges on this platform');
          return;
        }
        throw err;
      }
      assert.throws(() => workspace.writeFile('sub/link/evil.txt', 'x'), /symlink/);
      assert.equal(existsSync(path.join(outside, 'evil.txt')), false);
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test('workspace cannot see sibling workspaces', async () => {
    const siblingJob = 'job_b2c3d4e5-f6a7-4b2c-9d3e-234567890abc';
    mkdirSync(path.join(base, siblingJob), { recursive: true });
    const siblingFile = path.join(base, siblingJob, 'secret.txt');
    const { writeFileSync } = await import('node:fs');
    writeFileSync(siblingFile, 'sibling data');
    assert.equal(workspace.readFile(`../${siblingJob}/secret.txt`), undefined);
    assert.ok(!workspace.listFiles().includes(`../${siblingJob}/secret.txt`));
  });

  test('listFiles and readAllFiles round-trip', () => {
    workspace.writeFile('index.html', '<html></html>');
    workspace.writeFile('css/site.css', 'body{}');
    assert.deepEqual(workspace.listFiles(), ['css/site.css', 'index.html']);
    assert.equal(workspace.readFile('css/site.css'), 'body{}');
    assert.equal(workspace.readAllFiles().size, 2);
  });
});

describe('allowlisted exec', () => {
  test('isInsideDir semantics', () => {
    const parent = path.resolve(base);
    assert.ok(isInsideDir(parent, path.join(parent, 'child', 'file.txt')));
    assert.ok(!isInsideDir(parent, path.join(parent, '..', 'sibling')));
    assert.ok(isInsideDir(parent, parent));
  });

  test('runs allowlisted git commands inside base dir', async () => {
    const res = await runAllowlisted({ exe: 'git', args: ['status', '--short'], cwd: workspace.root, timeoutMs: 10000 }, base);
    assert.equal(res.code, 0);
    assert.equal(res.timedOut, false);
  });

  test('node is allowlisted for --version only', async () => {
    const ok = await runAllowlisted({ exe: 'node', args: ['--version'], cwd: workspace.root, timeoutMs: 10000 }, base);
    assert.equal(ok.code, 0);
    await assert.rejects(
      () => runAllowlisted({ exe: 'node', args: ['-e', 'process.exit(1)'], cwd: workspace.root, timeoutMs: 1000 }, base),
      /only allowlisted for --version/,
    );
  });

  test('rejects non-allowlisted executables', async () => {
    await assert.rejects(
      () => runAllowlisted({ exe: 'npm' as never, args: ['install'], cwd: workspace.root, timeoutMs: 1000 }, base),
      /not allowlisted/,
    );
  });

  test('rejects non-allowlisted and dangerous git subcommands/args', async () => {
    await assert.rejects(
      () => runAllowlisted({ exe: 'git', args: ['push', 'origin', 'main'], cwd: workspace.root, timeoutMs: 1000 }, base),
      /not allowlisted/,
    );
    await assert.rejects(
      () => runAllowlisted({ exe: 'git', args: ['status', '--upload-pack=evil'], cwd: workspace.root, timeoutMs: 1000 }, base),
      /dangerous git argument/,
    );
    await assert.rejects(
      () => runAllowlisted({ exe: 'git', args: ['-c', 'core.hooksPath=/tmp', 'commit', '-m', 'x'], cwd: workspace.root, timeoutMs: 1000 }, base),
      /not allowlisted: -c/,
    );
  });

  test('rejects cwd outside base dir', async () => {
    await assert.rejects(
      () => runAllowlisted({ exe: 'git', args: ['status'], cwd: path.resolve(base, '..', 'elsewhere'), timeoutMs: 1000 }, base),
      /escapes the approved base directory/,
    );
  });
});
