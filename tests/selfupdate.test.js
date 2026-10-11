import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { selfUpdate, autoUpdateOptOutPath } from '../src/selfupdate.js';
import { cloneGitRepo, tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function world() {
  const remote = tempBareGitRepo();
  const dev = tempGitRepo();
  git(dev, 'checkout', '-q', '-B', 'main');
  git(dev, 'remote', 'add', 'origin', remote);
  git(dev, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dev, 'tag', 'v2');
  git(dev, 'push', '-q', 'origin', 'v2');
  const app = cloneGitRepo(remote);
  const release = (message) => {
    git(dev, 'commit', '--allow-empty', '-q', '--no-verify', '-m', message);
    git(dev, 'push', '-q', 'origin', 'main');
    git(dev, 'tag', '-f', 'v2');
    git(dev, 'push', '-q', '-f', 'origin', 'v2');
  };
  return { dev, app, release, home: tempHome(), policy: () => { policy.calls += 1; } };
}
const policy = { calls: 0 };

test('fast-forwards to the released v2 tag and reinstalls the policy', () => {
  const w = world();
  policy.calls = 0;
  w.release('Released change');
  const result = selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy });
  assert.equal(result.updated, true);
  assert.equal(git(w.app, 'rev-parse', 'HEAD'), git(w.dev, 'rev-parse', 'HEAD'));
  assert.equal(policy.calls, 1);
  assert.equal(selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy }).reason, 'already on the latest release');
});

test('unreleased commits on main are NOT picked up', () => {
  const w = world();
  git(w.dev, 'commit', '--allow-empty', '-q', '--no-verify', '-m', 'Not released yet');
  git(w.dev, 'push', '-q', 'origin', 'main');
  const before = git(w.app, 'rev-parse', 'HEAD');
  const result = selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy });
  assert.equal(result.updated, false);
  assert.equal(git(w.app, 'rev-parse', 'HEAD'), before);
});

test('local changes, a non-main branch, and the opt-out file all block the update', () => {
  const w = world();
  w.release('Released change');
  const head = git(w.app, 'rev-parse', 'HEAD');

  fs.writeFileSync(path.join(w.app, 'app.txt'), 'edited\n');
  assert.match(selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy }).reason, /local changes/);
  git(w.app, 'checkout', '-q', '--', 'app.txt');

  git(w.app, 'checkout', '-q', '-b', 'topic');
  assert.match(selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy }).reason, /not on main/);
  git(w.app, 'checkout', '-q', 'main');

  fs.mkdirSync(path.dirname(autoUpdateOptOutPath(w.home)), { recursive: true });
  fs.writeFileSync(autoUpdateOptOutPath(w.home), '');
  assert.match(selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy }).reason, /turned off/);
  assert.equal(git(w.app, 'rev-parse', 'HEAD'), head);
});

test('a checkout that is ahead of the release is never moved, and offline is a quiet no-op', () => {
  const w = world();
  git(w.app, 'commit', '--allow-empty', '-q', '--no-verify', '-m', 'Local work');
  const ahead = git(w.app, 'rev-parse', 'HEAD');
  w.release('Released change');
  assert.match(selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy }).reason, /ahead of or diverged/);
  assert.equal(git(w.app, 'rev-parse', 'HEAD'), ahead);

  git(w.app, 'remote', 'set-url', 'origin', '/nonexistent/path');
  const offline = selfUpdate({ appDir: w.app, homeDir: w.home, reinstallPolicy: w.policy });
  assert.equal(offline.updated, false);
});

test('default policy refresh uses installed policy files, not agent CLIs on PATH', async () => {
  const { installGlobal, installedPolicyTargets } = await import('../src/install.js');
  const home = tempHome();
  assert.deepEqual(installedPolicyTargets(home), { claude: false, codex: false, agy: false });
  installGlobal({ homeDir: home, present: { claude: true, codex: false, agy: false } });
  assert.deepEqual(installedPolicyTargets(home), { claude: true, codex: false, agy: false });

  // Simulate a stale policy, then an update with a PATH that has no agent CLIs at all.
  const file = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('Progress comes from Git', 'STALE TEXT'));
  const w = world();
  w.release('Released change');
  const savedPath = process.env.PATH;
  process.env.PATH = path.dirname(process.execPath) + path.delimiter + '/usr/bin' + path.delimiter + '/bin';
  try {
    const result = selfUpdate({ appDir: w.app, homeDir: home });
    assert.equal(result.updated, true);
    assert.equal(result.policy, 'reinstalled');
  } finally {
    process.env.PATH = savedPath;
  }
  assert.match(fs.readFileSync(file, 'utf8'), /Progress comes from Git/);
  assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /STALE TEXT/);
});
