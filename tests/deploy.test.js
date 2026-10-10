import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { deployRepo } from '../src/deploy.js';
import { initRepo, loadState, startTask } from '../src/core.js';
import { WORKFLOW_FILE, renderWorkflow } from '../src/github.js';
import { readActivation } from '../src/ingest.js';
import { tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

const git = (repo, ...args) => String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' })).trim();
const head = (repo) => git(repo, 'rev-parse', 'HEAD');
const remoteHead = (bare, branch) => String(execFileSync(
  'git', ['--git-dir', bare, 'rev-parse', `refs/heads/${branch}`], { encoding: 'utf8' },
)).trim();
const contentAt = (bare, branch, file = WORKFLOW_FILE) => String(execFileSync(
  'git', ['--git-dir', bare, 'show', `refs/heads/${branch}:${file}`], { encoding: 'utf8' },
));

function fixture() {
  const repo = tempGitRepo();
  const remote = tempBareGitRepo();
  const home = tempHome();
  git(repo, 'checkout', '-q', '-B', 'main');
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  initRepo({ cwd: repo, homeDir: home, projectName: 'Deploy', obsidianNote: 'project - deploy.md' });
  startTask({
    cwd: repo, homeDir: home, id: 'legacy', title: 'Legacy progress',
    task: 'Preserve existing durable unit', current: 'Started before deployment',
  });
  git(repo, 'checkout', '-q', '-b', 'feat/afm');
  git(repo, 'commit', '-q', '--allow-empty', '-m', 'Implement initial AFM work');
  git(repo, 'push', '-q', '-u', 'origin', 'feat/afm');
  return { repo, remote, home };
}

test('deploy installs one central workflow on main and an existing worktree branch without touching durable units', () => {
  const w = fixture();
  const before = { main: remoteHead(w.remote, 'main'), afm: remoteHead(w.remote, 'feat/afm') };
  const oldWorktreeContent = fs.readFileSync(path.join(w.repo, 'app.txt'), 'utf8');
  const result = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(result.ok, true, JSON.stringify(result.blocked));
  assert.equal(result.activationCreated, true);
  assert.equal(result.deployed.length, 2);
  assert.deepEqual(result.blocked, []);
  assert.equal(contentAt(w.remote, 'main'), renderWorkflow());
  assert.equal(contentAt(w.remote, 'feat/afm'), renderWorkflow());
  assert.notEqual(remoteHead(w.remote, 'main'), before.main);
  assert.notEqual(remoteHead(w.remote, 'feat/afm'), before.afm);
  assert.equal(head(w.repo), remoteHead(w.remote, 'feat/afm'), 'checked-out branch fast-forwarded');
  assert.equal(git(w.repo, 'rev-parse', 'main'), remoteHead(w.remote, 'main'), 'idle local main fast-forwarded');
  assert.equal(git(w.repo, 'status', '--porcelain'), '', 'working tree stays clean');
  assert.equal(fs.readFileSync(path.join(w.repo, 'app.txt'), 'utf8'), oldWorktreeContent);

  const activation = readActivation(w.repo);
  assert.equal(activation.tips.main, before.main);
  assert.equal(activation.tips['feat/afm'], before.afm);
  assert.equal(loadState(w.repo).tasks.find((task) => task.id === 'legacy').current, 'Started before deployment');

  const stable = {
    main: remoteHead(w.remote, 'main'),
    afm: remoteHead(w.remote, 'feat/afm'),
    state: remoteHead(w.remote, 'docflow-state'),
  };
  const again = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(again.ok, true);
  assert.equal(again.activationCreated, false);
  assert.equal(again.hookChanged, false);
  assert.deepEqual(again.unchanged, ['feat/afm', 'main']);
  assert.equal(again.deployed.length, 0);
  assert.deepEqual({
    main: remoteHead(w.remote, 'main'),
    afm: remoteHead(w.remote, 'feat/afm'),
    state: remoteHead(w.remote, 'docflow-state'),
  }, stable);
});

test('deploy refuses a dirty checked-out branch, preserves its contents, and repairs on rerun', () => {
  const w = fixture();
  const beforeAfm = remoteHead(w.remote, 'feat/afm');
  fs.appendFileSync(path.join(w.repo, 'app.txt'), 'my unfinished work\n');
  const first = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(first.ok, false);
  assert.equal(first.deployed.length, 1, 'unaffected default branch can be deployed');
  assert.match(first.blocked[0].reason, /uncommitted/);
  assert.equal(first.blocked[0].branch, 'feat/afm');
  assert.equal(remoteHead(w.remote, 'feat/afm'), beforeAfm);
  assert.match(fs.readFileSync(path.join(w.repo, 'app.txt'), 'utf8'), /my unfinished work/);

  fs.writeFileSync(path.join(w.repo, 'app.txt'), 'initial\n');
  const retried = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(retried.ok, true);
  assert.deepEqual(retried.unchanged, ['main']);
  assert.equal(retried.deployed[0].branch, 'feat/afm');

  // Once remote deployment is complete, a dirty checkout cannot cause redundant writes.
  fs.appendFileSync(path.join(w.repo, 'app.txt'), 'another local edit\n');
  const existing = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(existing.ok, true);
  assert.equal(existing.deployed.length, 0);
  assert.equal(existing.unchanged.length, 2);
  assert.match(fs.readFileSync(path.join(w.repo, 'app.txt'), 'utf8'), /another local edit/);
});

test('deploy does not overwrite an unrelated workflow or touch its branch', () => {
  const w = fixture();
  const pathname = path.join(w.repo, WORKFLOW_FILE);
  fs.mkdirSync(path.dirname(pathname), { recursive: true });
  fs.writeFileSync(pathname, 'name: Custom workflow\non: push\njobs: {}\n');
  git(w.repo, 'add', WORKFLOW_FILE);
  git(w.repo, 'commit', '-q', '-m', 'Add custom workflow');
  git(w.repo, 'push', '-q', 'origin', 'feat/afm');
  const original = remoteHead(w.remote, 'feat/afm');
  const result = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(result.ok, false);
  assert.equal(result.blocked[0].branch, 'feat/afm');
  assert.match(result.blocked[0].reason, /not managed/);
  assert.equal(remoteHead(w.remote, 'feat/afm'), original);
  assert.equal(contentAt(w.remote, 'feat/afm'), 'name: Custom workflow\non: push\njobs: {}\n');
  assert.equal(fs.readFileSync(pathname, 'utf8'), 'name: Custom workflow\non: push\njobs: {}\n');
});

test('deploy never makes a remote branch diverge from locally committed work', () => {
  const w = fixture();
  const oldRemote = remoteHead(w.remote, 'feat/afm');
  git(w.repo, 'commit', '-q', '--allow-empty', '-m', 'Unpushed local feature work');
  const oldLocal = head(w.repo);
  const result = deployRepo({ cwd: w.repo, homeDir: w.home });
  assert.equal(result.ok, false);
  assert.match(result.blocked[0].reason, /differs from the remote tip/);
  assert.equal(remoteHead(w.remote, 'feat/afm'), oldRemote);
  assert.equal(head(w.repo), oldLocal);
  assert.equal(remoteHead(w.remote, 'main'), git(w.repo, 'rev-parse', 'main'));
});
