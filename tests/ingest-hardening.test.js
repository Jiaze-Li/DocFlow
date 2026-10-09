// Regression tests for three Codex findings on PR #6 (HEAD c2d983c). Real temp git repos,
// a bare remote and explicit event ordering; no mocks of git.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { initRepo, loadState } from '../src/core.js';
import { ACTIVATION_PATH, ingestPullRequest, ingestPush, readActivation } from '../src/ingest.js';
import { setupRepo } from '../src/setup-repo.js';
import { commitStateFiles } from '../src/state-store.js';
import { cloneGitRepo, tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

const ZERO = '0'.repeat(40);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const head = (repo) => git(repo, 'rev-parse', 'HEAD');
const commitOn = (repo, message) => { git(repo, 'commit', '--allow-empty', '-q', '--no-verify', '-m', message); return head(repo); };

function world({ activate = true, before = () => {} } = {}) {
  const remote = tempBareGitRepo();
  const dev = tempGitRepo();
  const home = tempHome();
  git(dev, 'remote', 'add', 'origin', remote);
  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dev, 'checkout', '-q', '-B', 'main');
  git(dev, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  initRepo({ cwd: dev, homeDir: home, projectName: 'Hardening', obsidianNote: 'project - hardening.md' });
  before({ dev, remote, home });
  if (activate) setupRepo({ cwd: dev, homeDir: home });
  const runner = () => ({ root: cloneGitRepo(remote), home: tempHome() });
  const fresh = () => loadState(cloneGitRepo(remote));
  const ingest = (args) => {
    const r = runner();
    return ingestPush({ cwd: r.root, homeDir: r.home, defaultBranch: 'main', ...args });
  };
  const pr = (payload) => {
    const r = runner();
    return ingestPullRequest({ cwd: r.root, homeDir: r.home, payload });
  };
  return { remote, dev, home, runner, fresh, ingest, pr };
}

// ---- Finding 1: first delivery of a branch push that arrives after the branch was merged ----

test('F1: delayed FIRST push of an already-merged branch records exactly the branch commits, never base history', () => {
  const w = world();
  const baseline = head(w.dev);
  git(w.dev, 'checkout', '-q', '-b', 'feat/merged-first');
  const a = commitOn(w.dev, 'Branch work one');
  const b = commitOn(w.dev, 'Branch work two');
  git(w.dev, 'push', '-q', 'origin', 'feat/merged-first');
  git(w.dev, 'checkout', '-q', 'main');
  const mainWork = commitOn(w.dev, 'Mainline work during the branch');
  git(w.dev, 'merge', '-q', '--no-ff', '-m', 'Merge pull request from feat/merged-first', 'feat/merged-first');
  const merge = head(w.dev);
  const after = commitOn(w.dev, 'Mainline work after the merge');
  git(w.dev, 'push', '-q', 'origin', 'main');

  // The push event for the branch is only processed now, long after the merge.
  const res = w.ingest({ ref: 'refs/heads/feat/merged-first', before: ZERO, after: b });
  assert.deepEqual(res.recorded, [a, b]);
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/merged-first');
  assert.deepEqual(unit.commits.map((c) => c.sha), [a, b]);
  const recorded = new Set(unit.commits.map((c) => c.sha));
  for (const sha of [baseline, mainWork, merge, after]) assert.equal(recorded.has(sha), false, `base commit ${sha.slice(0, 7)} must not be recorded`);
  // Replaying the same delayed delivery is a no-op.
  assert.deepEqual(w.ingest({ ref: 'refs/heads/feat/merged-first', before: ZERO, after: b }).recorded, []);
});

test('F1 control: a branch cut from base with no commits of its own still creates no unit', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/just-cut');
  git(w.dev, 'push', '-q', 'origin', 'feat/just-cut');
  const res = w.ingest({ ref: 'refs/heads/feat/just-cut', before: ZERO, after: head(w.dev) });
  assert.deepEqual(res.recorded, []);
  assert.equal(w.fresh().tasks.some((t) => t.id === 'feat/just-cut'), false);
});

test('F1 control: a branch pointing at an old base commit that was never merged-as-a-branch creates no unit', () => {
  const w = world();
  const old = head(w.dev);
  commitOn(w.dev, 'Newer mainline work');
  git(w.dev, 'push', '-q', 'origin', 'main');
  git(w.dev, 'push', '-q', 'origin', `${old}:refs/heads/feat/points-at-old-main`);
  const res = w.ingest({ ref: 'refs/heads/feat/points-at-old-main', before: ZERO, after: old });
  assert.deepEqual(res.recorded, []);
  assert.equal(w.fresh().tasks.some((t) => t.id === 'feat/points-at-old-main'), false);
});

// ---- Finding 2: activation-time anchor for pre-existing branches ----

function oldBranchWorld() {
  return world({
    activate: false,
    before: ({ dev }) => {
      git(dev, 'checkout', '-q', '-b', 'feat/old');
      commitOn(dev, 'Old work one');
      commitOn(dev, 'Old work two');
      git(dev, 'push', '-q', 'origin', 'feat/old');
    },
  });
}

test('F2: the activation record anchors each pre-existing branch tip', () => {
  const w = oldBranchWorld();
  const oldTip = head(w.dev);
  setupRepo({ cwd: w.dev, homeDir: w.home });
  const activation = readActivation(w.dev);
  assert.equal(activation.tips?.['feat/old'], oldTip);
  assert.ok(activation.branches.includes('feat/old'));
});

test('F2: first post-activation run is lost; the next push still recovers the missed commit', () => {
  const w = oldBranchWorld();
  const oldTip = head(w.dev);
  setupRepo({ cwd: w.dev, homeDir: w.home });
  const missed = commitOn(w.dev, 'Change whose first Action run was lost');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const next = commitOn(w.dev, 'Next change after the lost run');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const res = w.ingest({ ref: 'refs/heads/feat/old', before: missed, after: next });
  assert.deepEqual(res.recorded, [missed, next]);
  assert.equal(res.recovery?.anchored, true);
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/old');
  assert.deepEqual(unit.commits.map((c) => c.sha), [missed, next]);
  assert.equal(unit.commits.some((c) => c.sha === oldTip), false, 'pre-activation history is never backfilled');
});

test('F2: a PR event (no `before`) on a pre-existing branch recovers everything since activation', () => {
  const w = oldBranchWorld();
  setupRepo({ cwd: w.dev, homeDir: w.home });
  const one = commitOn(w.dev, 'Post-activation one');
  const two = commitOn(w.dev, 'Post-activation two');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const res = w.pr({
    repository: { default_branch: 'main' },
    pull_request: { number: 4, state: 'open', merged: false, title: 'PR', html_url: 'https://example.test/4', head: { ref: 'feat/old', sha: two, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } } },
  });
  assert.deepEqual(res.recorded, [one, two]);
});

test('F2 compat: a legacy activation record (no tips) stays forward-only and says it cannot recover', () => {
  const w = oldBranchWorld();
  const oldTip = head(w.dev);
  commitStateFiles({
    repoRoot: w.dev, homeDir: w.home,
    files: { [ACTIVATION_PATH]: `${JSON.stringify({ schemaVersion: 1, activatedAt: '2026-10-01T00:00:00.000Z', branches: ['feat/old', 'main'] }, null, 2)}\n` },
    expectedFiles: { [ACTIVATION_PATH]: null },
    message: 'DocFlow: activate commit-native progress (legacy)',
    allowCreate: true,
  });
  assert.equal(readActivation(w.dev).tips, undefined);
  const missed = commitOn(w.dev, 'Missed under the legacy record');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const next = commitOn(w.dev, 'Next under the legacy record');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const res = w.ingest({ ref: 'refs/heads/feat/old', before: missed, after: next });
  // Legacy behaviour is preserved (forward-only, no backfill) ...
  assert.deepEqual(res.recorded, [next]);
  assert.equal(w.fresh().tasks.find((t) => t.id === 'feat/old').commits.some((c) => c.sha === oldTip), false);
  // ... but it must never pretend that a lost earlier run was recovered.
  assert.equal(res.recovery?.anchored, false);
  assert.equal(res.recovery?.legacyActivation, true);
  assert.match(res.recovery?.note ?? '', /cannot be recovered/i);
});

test('F2: an anchor that is no longer an ancestor (rewritten history) is reported, not silently trusted', () => {
  const w = oldBranchWorld();
  const oldTip = head(w.dev);
  setupRepo({ cwd: w.dev, homeDir: w.home });
  git(w.dev, 'reset', '-q', '--hard', 'HEAD~1'); // rewrite: the anchored tip is gone from the branch
  const rewritten = commitOn(w.dev, 'Rewritten branch tip');
  git(w.dev, 'push', '-q', '--force', 'origin', 'feat/old');
  const res = w.ingest({ ref: 'refs/heads/feat/old', before: oldTip, after: rewritten });
  assert.equal(res.recovery?.anchored, false);
  assert.match(res.recovery?.note ?? '', /not an ancestor|rewritten/i);
  assert.deepEqual(res.recorded, [rewritten]);
});

test('F1+F2: a merged PRE-EXISTING branch records only post-activation commits, never its pre-activation history', () => {
  const w = world({
    activate: false,
    before: ({ dev }) => {
      git(dev, 'checkout', '-q', '-b', 'feat/old-merged');
      commitOn(dev, 'Pre-activation one');
      commitOn(dev, 'Pre-activation two');
      git(dev, 'push', '-q', 'origin', 'feat/old-merged');
    },
  });
  const anchor = head(w.dev);
  const [p1, p2] = git(w.dev, 'rev-list', '--reverse', '-n', '2', 'HEAD').split('\n');
  setupRepo({ cwd: w.dev, homeDir: w.home });
  const fresh = commitOn(w.dev, 'Post-activation work');
  git(w.dev, 'push', '-q', 'origin', 'feat/old-merged');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--no-ff', '-m', 'Merge feat/old-merged', 'feat/old-merged');
  git(w.dev, 'push', '-q', 'origin', 'main');
  const res = w.ingest({ ref: 'refs/heads/feat/old-merged', before: anchor, after: fresh });
  assert.deepEqual(res.recorded, [fresh]);
  const shas = w.fresh().tasks.find((t) => t.id === 'feat/old-merged').commits.map((c) => c.sha);
  assert.deepEqual(shas, [fresh]);
  assert.equal(shas.includes(anchor), false);
  assert.equal(shas.includes(p1) || shas.includes(p2), false);
});

test('F1+F2 compat: legacy activation + merged pre-existing branch records nothing (cannot prove the boundary)', () => {
  const w = world({
    activate: false,
    before: ({ dev }) => {
      git(dev, 'checkout', '-q', '-b', 'feat/legacy-merged');
      commitOn(dev, 'Pre-activation work');
      git(dev, 'push', '-q', 'origin', 'feat/legacy-merged');
    },
  });
  const anchor = head(w.dev);
  commitStateFiles({
    repoRoot: w.dev, homeDir: w.home,
    files: { [ACTIVATION_PATH]: `${JSON.stringify({ schemaVersion: 1, activatedAt: '2026-10-01T00:00:00.000Z', branches: ['feat/legacy-merged', 'main'] }, null, 2)}\n` },
    expectedFiles: { [ACTIVATION_PATH]: null },
    message: 'DocFlow: activate commit-native progress (legacy)',
    allowCreate: true,
  });
  const fresh = commitOn(w.dev, 'Post-activation work');
  git(w.dev, 'push', '-q', 'origin', 'feat/legacy-merged');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--no-ff', '-m', 'Merge feat/legacy-merged', 'feat/legacy-merged');
  git(w.dev, 'push', '-q', 'origin', 'main');
  const res = w.ingest({ ref: 'refs/heads/feat/legacy-merged', before: anchor, after: fresh });
  assert.deepEqual(res.recorded, []);
  assert.equal(res.recovery?.anchored, false);
  assert.equal(w.fresh().tasks.some((t) => t.id === 'feat/legacy-merged'), false);
});

// ---- Finding 3: reopened pull requests ----

const T = (hour) => `2026-10-02T${String(hour).padStart(2, '0')}:00:00Z`;
function payload({ action, number = 21, branch, sha, state = 'open', merged = false, updatedAt, closedAt = null }) {
  return {
    action,
    repository: { default_branch: 'main' },
    pull_request: {
      number, state, merged, title: `PR ${number}`, html_url: `https://example.test/pr/${number}`,
      merged_at: merged ? closedAt : null, closed_at: state === 'closed' ? closedAt : null, updated_at: updatedAt,
      head: { ref: branch, sha, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } },
    },
  };
}
function prWorld(branch) {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', branch);
  const c1 = commitOn(w.dev, 'Work behind a pull request');
  git(w.dev, 'push', '-q', 'origin', branch);
  w.pr(payload({ action: 'opened', branch, sha: c1, updatedAt: T(1) }));
  return { w, c1 };
}
const unitOf = (w, branch) => w.fresh().tasks.find((t) => t.id === branch);

test('F3: reopening a closed-without-merge PR restores the unit and clears the stale closure', () => {
  const { w, c1 } = prWorld('feat/reopen');
  w.pr(payload({ action: 'closed', branch: 'feat/reopen', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  let unit = unitOf(w, 'feat/reopen');
  assert.equal(unit.status, 'Abandoned');
  w.pr(payload({ action: 'reopened', branch: 'feat/reopen', sha: c1, updatedAt: T(3) }));
  unit = unitOf(w, 'feat/reopen');
  assert.equal(unit.status, 'In progress');
  assert.equal(unit.outcome, null);
  assert.equal(unit.completed, null);
  assert.equal(unit.pr.state, 'open');
  assert.deepEqual(unit.commits.map((c) => c.sha), [c1], 'history is untouched');
});

test('F3: a stale reopened event (older than the recorded closure) does not reopen', () => {
  const { w, c1 } = prWorld('feat/stale-reopen');
  w.pr(payload({ action: 'closed', branch: 'feat/stale-reopen', sha: c1, state: 'closed', closedAt: T(5), updatedAt: T(5) }));
  w.pr(payload({ action: 'reopened', branch: 'feat/stale-reopen', sha: c1, updatedAt: T(3) }));
  const unit = unitOf(w, 'feat/stale-reopen');
  assert.equal(unit.status, 'Abandoned');
  assert.equal(unit.outcome, 'Closed without merge');
});

test('F3: late opened / synchronize events never reopen an abandoned unit', () => {
  const { w, c1 } = prWorld('feat/late-opened');
  w.pr(payload({ action: 'closed', branch: 'feat/late-opened', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  w.pr(payload({ action: 'opened', branch: 'feat/late-opened', sha: c1, updatedAt: T(1) }));
  w.pr(payload({ action: 'synchronize', branch: 'feat/late-opened', sha: c1, updatedAt: T(4) }));
  assert.equal(unitOf(w, 'feat/late-opened').status, 'Abandoned');
});

test('F3: a merged unit is never reopened, even by a reopened event', () => {
  const { w, c1 } = prWorld('feat/merged-stays');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--ff-only', 'feat/merged-stays');
  git(w.dev, 'push', '-q', 'origin', 'main');
  w.pr(payload({ action: 'closed', branch: 'feat/merged-stays', sha: c1, state: 'closed', merged: true, closedAt: T(2), updatedAt: T(2) }));
  w.pr(payload({ action: 'reopened', branch: 'feat/merged-stays', sha: c1, updatedAt: T(9) }));
  const unit = unitOf(w, 'feat/merged-stays');
  assert.equal(unit.status, 'Completed');
  assert.equal(unit.outcome, 'Merged');
});

test('F3: a stale closed event delivered after a newer reopen does not re-abandon the unit', () => {
  const { w, c1 } = prWorld('feat/close-after-reopen');
  w.pr(payload({ action: 'closed', branch: 'feat/close-after-reopen', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  w.pr(payload({ action: 'reopened', branch: 'feat/close-after-reopen', sha: c1, updatedAt: T(6) }));
  w.pr(payload({ action: 'closed', branch: 'feat/close-after-reopen', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  assert.equal(unitOf(w, 'feat/close-after-reopen').status, 'In progress');
});

test('F3: a genuine reopened event delivered AFTER a newer synchronize still reopens the unit', () => {
  const { w, c1 } = prWorld('feat/reorder-reopen');
  w.pr(payload({ action: 'closed', branch: 'feat/reorder-reopen', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  // Real order of events: closed(T2) -> reopened(T3) -> synchronize(T4); delivered: closed, synchronize, reopened.
  w.pr(payload({ action: 'synchronize', branch: 'feat/reorder-reopen', sha: c1, updatedAt: T(4) }));
  w.pr(payload({ action: 'reopened', branch: 'feat/reorder-reopen', sha: c1, updatedAt: T(3) }));
  const unit = unitOf(w, 'feat/reorder-reopen');
  assert.equal(unit.status, 'In progress');
  assert.equal(unit.completed, null);
  assert.equal(unit.pr.updatedAt, T(4), 'recorded PR time never moves backwards');
});

test('F3: a later close is still applied after the reorder (closed T5 after synchronize T4)', () => {
  const { w, c1 } = prWorld('feat/reorder-then-close');
  w.pr(payload({ action: 'closed', branch: 'feat/reorder-then-close', sha: c1, state: 'closed', closedAt: T(2), updatedAt: T(2) }));
  w.pr(payload({ action: 'synchronize', branch: 'feat/reorder-then-close', sha: c1, updatedAt: T(4) }));
  w.pr(payload({ action: 'reopened', branch: 'feat/reorder-then-close', sha: c1, updatedAt: T(3) }));
  w.pr(payload({ action: 'closed', branch: 'feat/reorder-then-close', sha: c1, state: 'closed', closedAt: T(5), updatedAt: T(5) }));
  const unit = unitOf(w, 'feat/reorder-then-close');
  assert.equal(unit.status, 'Abandoned');
  assert.equal(unit.completed, T(5));
});
