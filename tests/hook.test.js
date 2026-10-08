import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { initRepo } from '../src/core.js';
import { HOOK_MARKER, commitHookStatus, installCommitHook } from '../src/hooks.js';
import { tempGitRepo, tempHome } from './helpers.js';

function commit(repo, message, { amend = false } = {}) {
  fs.appendFileSync(path.join(repo, 'app.txt'), `${Math.random()}\n`);
  execFileSync('git', ['-C', repo, 'add', 'app.txt']);
  return spawnSync('git', ['-C', repo, 'commit', '-q', ...(amend ? ['--amend'] : []), '-m', message], { encoding: 'utf8' });
}

test('real git commit: valid message accepted, placeholder rejected with actionable remediation', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, homeDir: tempHome(), projectName: 'Hook', obsidianNote: 'project - hook.md' });
  const status = installCommitHook({ cwd: repo });
  assert.equal(status.state, 'current');
  assert.ok((fs.statSync(status.path).mode & 0o111) !== 0);

  const before = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const bad = commit(repo, 'wip');
  assert.notEqual(bad.status, 0);
  assert.match(bad.stderr, /commit message rejected/);
  assert.match(bad.stderr, /Why:/);
  assert.match(bad.stderr, /Change:/);
  assert.match(bad.stderr, /Retry:/);
  assert.equal(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), before, 'commit object must not be accepted');

  const good = commit(repo, 'Add retry to the upload step');
  assert.equal(good.status, 0, good.stderr);
  assert.equal(execFileSync('git', ['-C', repo, 'log', '-1', '--format=%s'], { encoding: 'utf8' }).trim(), 'Add retry to the upload step');
});

test('hook install is idempotent, repairs stale managed hooks, and never overwrites a foreign hook', () => {
  const repo = tempGitRepo();
  assert.equal(commitHookStatus({ cwd: repo }).state, 'missing');
  installCommitHook({ cwd: repo });
  assert.equal(installCommitHook({ cwd: repo }).changed, false);

  const file = commitHookStatus({ cwd: repo }).path;
  fs.writeFileSync(file, `#!/bin/sh\n${HOOK_MARKER}\nexit 0\n`, { mode: 0o755 });
  assert.equal(commitHookStatus({ cwd: repo }).state, 'stale');
  assert.equal(installCommitHook({ cwd: repo }).changed, true);
  assert.equal(commitHookStatus({ cwd: repo }).state, 'current');

  const foreignRepo = tempGitRepo();
  const foreign = '#!/bin/sh\necho "team hook"\nexit 0\n';
  const foreignPath = commitHookStatus({ cwd: foreignRepo }).path;
  fs.mkdirSync(path.dirname(foreignPath), { recursive: true });
  fs.writeFileSync(foreignPath, foreign, { mode: 0o755 });
  assert.equal(commitHookStatus({ cwd: foreignRepo }).state, 'foreign');
  assert.throws(() => installCommitHook({ cwd: foreignRepo }), /will not overwrite[\s\S]*validate-message/);
  assert.equal(fs.readFileSync(foreignPath, 'utf8'), foreign);
});

test('hook respects core.hooksPath and fails open (visibly) if the validator disappears', () => {
  const repo = tempGitRepo();
  const hooksDir = path.join(repo, '.custom-hooks');
  execFileSync('git', ['-C', repo, 'config', 'core.hooksPath', hooksDir]);
  const status = installCommitHook({ cwd: repo, cliPath: path.join(repo, 'missing-cli.js') });
  assert.equal(path.dirname(status.path), hooksDir);
  const res = commit(repo, 'wip');
  assert.equal(res.status, 0);
  assert.match(res.stderr, /validator not found/);
});
