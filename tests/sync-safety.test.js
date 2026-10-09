import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { checkpoint, configureGlobal, initRepo, startTask, syncObsidian } from '../src/core.js';
import { lockIsStale, refreshStateFromOrigin, withStateLock } from '../src/state-store.js';
import { tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

function world() {
  const repo = tempGitRepo();
  const home = tempHome();
  const projects = path.join(home, 'Vault', 'Projects');
  fs.mkdirSync(projects, { recursive: true });
  configureGlobal({ homeDir: home, vault: path.join(home, 'Vault'), projectFolder: 'Projects' });
  initRepo({ cwd: repo, projectName: 'P', obsidianNote: 'p.md' });
  startTask({ cwd: repo, id: '1', title: 'T', task: 'Do it.', current: 'First.', next: 'Second.' });
  return { repo, home, note: path.join(projects, 'p.md') };
}

const pastMtime = (file) => {
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(file, old, old);
  return fs.statSync(file).mtimeMs;
};

test('a second sync with unchanged progress does not touch the note', () => {
  const w = world();
  const first = syncObsidian({ cwd: w.repo, homeDir: w.home });
  assert.equal(first.created, true);
  const mtime = pastMtime(w.note);
  const before = fs.readFileSync(w.note, 'utf8');
  const second = syncObsidian({ cwd: w.repo, homeDir: w.home });
  assert.equal(second.unchanged, true);
  assert.equal(fs.statSync(w.note).mtimeMs, mtime);
  assert.equal(fs.readFileSync(w.note, 'utf8'), before);
});

test('real progress changes are still written, then go quiet again', () => {
  const w = world();
  syncObsidian({ cwd: w.repo, homeDir: w.home });
  pastMtime(w.note);
  checkpoint({ cwd: w.repo, current: 'Changed.', next: 'More.' });
  const r = syncObsidian({ cwd: w.repo, homeDir: w.home });
  assert.equal(r.unchanged, false);
  assert.match(fs.readFileSync(w.note, 'utf8'), /Changed\./);
  const mtime = pastMtime(w.note);
  assert.equal(syncObsidian({ cwd: w.repo, homeDir: w.home }).unchanged, true);
  assert.equal(fs.statSync(w.note).mtimeMs, mtime);
});

test('a failed sync leaves no state: the next sync retries and writes', () => {
  const w = world();
  const target = path.dirname(w.note);
  fs.rmSync(target, { recursive: true });
  fs.writeFileSync(target, 'a file where the folder should be');
  assert.throws(() => syncObsidian({ cwd: w.repo, homeDir: w.home }));
  fs.rmSync(target);
  const r = syncObsidian({ cwd: w.repo, homeDir: w.home });
  assert.equal(r.created, true);
  assert.ok(fs.existsSync(w.note));
});

test('network Git calls carry a 15s timeout and never prompt; every Git call has some timeout', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const remote = tempBareGitRepo();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:refs/heads/docflow-state']);
  const calls = [];
  const exec = (cmd, args, opts) => { calls.push({ args, opts }); return execFileSync(cmd, args, opts); };
  refreshStateFromOrigin({ repoRoot: repo, homeDir: home, exec });
  const net = calls.filter((c) => c.args.includes('ls-remote') || c.args.includes('fetch'));
  assert.ok(net.length >= 1);
  for (const c of net) {
    assert.equal(c.opts.timeout, 15000);
    assert.equal(c.opts.env.GIT_TERMINAL_PROMPT, '0');
  }
  assert.ok(calls.every((c) => c.opts.timeout > 0), 'no Git call may be unbounded');
});

test('a timed-out network call fails fast instead of hanging, and the lock is released', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://example.invalid/x.git']);
  const exec = (cmd, args, opts) => {
    if (args.includes('ls-remote')) { const e = new Error('spawnSync git ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; }
    return execFileSync(cmd, args, opts);
  };
  assert.throws(() => refreshStateFromOrigin({ repoRoot: repo, homeDir: home, exec }), /ls-remote/);
  assert.equal(fs.readdirSync(path.join(home, '.docflow', 'locks')).length, 0);
  assert.equal(withStateLock(repo, home, execFileSync, () => 'ok'), 'ok');
});

test('a lock held by a live process is not stale however old; a dead owner’s lock is', () => {
  const dir = fs.mkdtempSync(path.join(tempHome(), 'l-'));
  const lock = path.join(dir, 'a.lock');
  const old = new Date(Date.now() - 120_000);
  fs.writeFileSync(lock, `${process.pid}\n`);
  fs.utimesSync(lock, old, old);
  assert.equal(lockIsStale(lock, 30000), false);
  const ancient = new Date(Date.now() - 3 * 3600_000);
  fs.utimesSync(lock, ancient, ancient);
  assert.equal(lockIsStale(lock, 30000), false, 'a live owner is never robbed, even after hours');
  fs.writeFileSync(lock, '2147483646\n');
  fs.utimesSync(lock, old, old);
  assert.equal(lockIsStale(lock, 30000), true);
  fs.writeFileSync(lock, `${process.pid}\n`);
  assert.equal(lockIsStale(lock, 30000), false, 'fresh lock');
});
