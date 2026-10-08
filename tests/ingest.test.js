import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initRepo, loadState } from '../src/core.js';
import { WORKFLOW_MARKER, renderWorkflow } from '../src/github.js';
import { ingestPullRequest, ingestPush, readActivation } from '../src/ingest.js';
import { setupRepo } from '../src/setup-repo.js';
import { cloneGitRepo, tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'docflow.js');
const ZERO = '0'.repeat(40);

const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const head = (repo) => git(repo, 'rev-parse', 'HEAD');

function commitOn(repo, message) {
  git(repo, 'commit', '--allow-empty', '-q', '--no-verify', '-m', message);
  return head(repo);
}

/** A developer clone with DocFlow enabled and a remote, plus helpers to simulate a CI runner. */
function world({ activate = true, before = () => {} } = {}) {
  const remote = tempBareGitRepo();
  const dev = tempGitRepo();
  const home = tempHome();
  git(dev, 'remote', 'add', 'origin', remote);
  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dev, 'checkout', '-q', '-B', 'main');
  git(dev, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  initRepo({ cwd: dev, homeDir: home, projectName: 'Ingest', obsidianNote: 'project - ingest.md' });
  before({ dev, remote, home });
  if (activate) setupRepo({ cwd: dev, homeDir: home });
  const runner = () => {
    const root = cloneGitRepo(remote);
    return { root, home: tempHome() };
  };
  const fresh = () => loadState(cloneGitRepo(remote));
  const ingest = (args) => {
    const r = runner();
    return ingestPush({ cwd: r.root, homeDir: r.home, defaultBranch: 'main', ...args });
  };
  return { remote, dev, home, runner, fresh, ingest };
}

const stateCommit = (remote) => execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/docflow-state'], { encoding: 'utf8' }).trim();

test('multi-commit push records every distinct SHA once, in order, identical subjects stay distinct', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/multi');
  const shas = [commitOn(w.dev, 'Add upload retry'), commitOn(w.dev, 'Tune upload retry'), commitOn(w.dev, 'Add upload retry')];
  git(w.dev, 'push', '-q', 'origin', 'feat/multi');

  const res = w.ingest({ ref: 'refs/heads/feat/multi', before: ZERO, after: shas[2] });
  assert.deepEqual(res.recorded, shas);
  assert.equal(res.mode, 'create');

  const unit = w.fresh().tasks.find((t) => t.id === 'feat/multi');
  assert.deepEqual(unit.commits.map((c) => c.sha), shas);
  assert.equal(unit.current, 'Add upload retry');
  assert.deepEqual(unit.history.map((h) => h.text), ['Add upload retry', 'Tune upload retry']);
  assert.equal(unit.next, '');
});

test('duplicate delivery is a no-op and publishes no new state commit', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/dup');
  const shas = [commitOn(w.dev, 'First real change'), commitOn(w.dev, 'Second real change')];
  git(w.dev, 'push', '-q', 'origin', 'feat/dup');
  w.ingest({ ref: 'refs/heads/feat/dup', before: ZERO, after: shas[1] });
  const published = stateCommit(w.remote);
  const again = w.ingest({ ref: 'refs/heads/feat/dup', before: ZERO, after: shas[1] });
  assert.deepEqual(again.recorded, []);
  assert.deepEqual(again.alreadyRecorded, []);
  assert.equal(stateCommit(w.remote), published);
  assert.equal(w.fresh().tasks.find((t) => t.id === 'feat/dup').commits.length, 2);
});

test('a missed run is recovered by the next push without scanning older history', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/missed');
  const c1 = commitOn(w.dev, 'Delivered change one');
  git(w.dev, 'push', '-q', 'origin', 'feat/missed');
  w.ingest({ ref: 'refs/heads/feat/missed', before: ZERO, after: c1 });

  const c2 = commitOn(w.dev, 'Change whose run was lost');
  git(w.dev, 'push', '-q', 'origin', 'feat/missed'); // no ingestion for this push
  const c3 = commitOn(w.dev, 'Change after the lost run');
  git(w.dev, 'push', '-q', 'origin', 'feat/missed');
  const res = w.ingest({ ref: 'refs/heads/feat/missed', before: c2, after: c3 });
  assert.equal(res.mode, 'reconcile');
  assert.deepEqual(res.recorded, [c2, c3]);
  assert.deepEqual(w.fresh().tasks.find((t) => t.id === 'feat/missed').commits.map((c) => c.sha), [c1, c2, c3]);
});

test('branch created after activation whose creation run was lost is recovered in full', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/lost-create');
  const c1 = commitOn(w.dev, 'Lost creation change');
  git(w.dev, 'push', '-q', 'origin', 'feat/lost-create');
  const c2 = commitOn(w.dev, 'Following change');
  git(w.dev, 'push', '-q', 'origin', 'feat/lost-create');
  const res = w.ingest({ ref: 'refs/heads/feat/lost-create', before: c1, after: c2 });
  assert.equal(res.mode, 'create-missed');
  assert.deepEqual(res.recorded, [c1, c2]);
});

test('pre-activation branches are forward-only: no historical backfill', () => {
  const w = world({
    activate: false,
    before: ({ dev }) => {
      git(dev, 'checkout', '-q', '-b', 'feat/old');
      commitOn(dev, 'Old work one');
      commitOn(dev, 'Old work two');
      git(dev, 'push', '-q', 'origin', 'feat/old');
    },
  });
  setupRepo({ cwd: w.dev, homeDir: w.home }); // activation snapshot lists feat/old
  assert.ok(readActivation(w.dev).branches.includes('feat/old'));
  const oldTip = head(w.dev);
  const fresh = commitOn(w.dev, 'First post-activation change');
  git(w.dev, 'push', '-q', 'origin', 'feat/old');
  const res = w.ingest({ ref: 'refs/heads/feat/old', before: oldTip, after: fresh });
  assert.equal(res.mode, 'forward');
  assert.deepEqual(res.recorded, [fresh]);
  assert.deepEqual(w.fresh().tasks.find((t) => t.id === 'feat/old').commits.map((c) => c.sha), [fresh]);
});

test('stacked post-activation branches never lose shared commits, whichever run goes first', () => {
  for (const order of ['a-first', 'b-first']) {
    const w = world();
    git(w.dev, 'checkout', '-q', '-b', 'feat/base-a');
    const a1 = commitOn(w.dev, 'Work belonging to A');
    git(w.dev, 'push', '-q', 'origin', 'feat/base-a');
    git(w.dev, 'checkout', '-q', '-b', 'feat/stacked-b');
    const b1 = commitOn(w.dev, 'Work belonging to B');
    git(w.dev, 'push', '-q', 'origin', 'feat/stacked-b');
    const runA = () => w.ingest({ ref: 'refs/heads/feat/base-a', before: ZERO, after: a1 });
    const runB = () => w.ingest({ ref: 'refs/heads/feat/stacked-b', before: ZERO, after: b1 });
    if (order === 'a-first') { runA(); runB(); } else { runB(); runA(); }
    const units = w.fresh().tasks;
    const recorded = units.flatMap((u) => u.commits.map((c) => c.sha));
    assert.deepEqual([...recorded].sort(), [a1, b1].sort(), order);
    if (order === 'a-first') assert.deepEqual(units.find((u) => u.id === 'feat/stacked-b').commits.map((c) => c.sha), [b1]);
  }
});

test('a branch stacked on a pre-activation branch does not backfill that branch\'s history', () => {
  const w = world({
    activate: false,
    before: ({ dev }) => {
      git(dev, 'checkout', '-q', '-b', 'feat/legacy');
      commitOn(dev, 'Legacy history one');
      commitOn(dev, 'Legacy history two');
      git(dev, 'push', '-q', 'origin', 'feat/legacy');
    },
  });
  setupRepo({ cwd: w.dev, homeDir: w.home });
  git(w.dev, 'checkout', '-q', '-b', 'feat/on-legacy');
  const mine = commitOn(w.dev, 'My own new change');
  git(w.dev, 'push', '-q', 'origin', 'feat/on-legacy');
  const res = w.ingest({ ref: 'refs/heads/feat/on-legacy', before: ZERO, after: mine });
  assert.deepEqual(res.recorded, [mine]);
});

test('ingestion requires an activation record (no accidental backfill on non-activated repos)', () => {
  const w = world({ activate: false });
  git(w.dev, 'checkout', '-q', '-b', 'feat/inactive');
  const sha = commitOn(w.dev, 'Unactivated repository change');
  git(w.dev, 'push', '-q', 'origin', 'feat/inactive');
  assert.throws(() => w.ingest({ ref: 'refs/heads/feat/inactive', before: ZERO, after: sha }), /not activated/);
});

test('empty and oversized commit messages that reach GitHub are ingested under a stand-in subject with a warning', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/odd-messages');
  const good = commitOn(w.dev, 'A perfectly fine change');
  git(w.dev, 'commit', '--allow-empty', '-q', '--no-verify', '--allow-empty-message', '-m', '');
  const empty = head(w.dev);
  git(w.dev, 'commit', '--allow-empty', '-q', '--no-verify', '-m', `Oversized body subject`, '-m', 'x'.repeat(150000));
  const huge = head(w.dev);
  const last = commitOn(w.dev, 'Change after the odd ones');
  git(w.dev, 'push', '-q', 'origin', 'feat/odd-messages');
  const res = w.ingest({ ref: 'refs/heads/feat/odd-messages', before: ZERO, after: last });
  assert.deepEqual(res.recorded, [good, empty, huge, last]);
  assert.ok(res.warnings.some((x) => x.sha === empty));
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/odd-messages');
  assert.equal(unit.commits[1].message, '(empty commit message)');
  assert.equal(unit.commits[2].message, 'Oversized body subject');
  // The branch is not stuck: a later reconcile still works.
  const next = commitOn(w.dev, 'Following change');
  git(w.dev, 'push', '-q', 'origin', 'feat/odd-messages');
  assert.deepEqual(w.ingest({ ref: 'refs/heads/feat/odd-messages', before: last, after: next }).recorded, [next]);
});

test('merged-tip reconcile is bounded: an unconnected rebased tip records only the tip, never base history', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', 'main');
  for (let i = 0; i < 4; i += 1) commitOn(w.dev, `Base history commit ${i}`);
  git(w.dev, 'push', '-q', 'origin', 'main');
  git(w.dev, 'checkout', '-q', '-b', 'feat/rewritten', 'main');
  const c1 = commitOn(w.dev, 'Recorded before the rewrite');
  git(w.dev, 'push', '-q', 'origin', 'feat/rewritten');
  w.ingest({ ref: 'refs/heads/feat/rewritten', before: ZERO, after: c1 });

  // The branch is rewritten (its run is missed), then merged into main.
  git(w.dev, 'checkout', '-q', '-B', 'feat/rewritten', 'main~2');
  const d1 = commitOn(w.dev, 'Rewritten history one');
  const d2 = commitOn(w.dev, 'Rewritten history two');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--no-edit', 'feat/rewritten');
  git(w.dev, 'push', '-q', 'origin', 'main');
  git(w.dev, 'push', '-q', '--force', 'origin', 'feat/rewritten');
  const res = w.ingest({ ref: 'refs/heads/feat/rewritten', before: c1, after: d2 });
  assert.ok(['reconcile-merged', 'reconcile-merged-tip'].includes(res.mode), res.mode);
  assert.ok(res.recorded.length <= 2 && res.recorded.includes(d2), JSON.stringify(res.recorded));
  assert.ok(!res.recorded.some((sha) => sha !== d1 && sha !== d2));
  const total = w.fresh().tasks.find((t) => t.id === 'feat/rewritten').commits.length;
  assert.ok(total <= 3, `no base history backfill (got ${total})`);
});

test('non-fast-forward / rebased pushes preserve recorded progress and add only unseen SHAs', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/rebase');
  const c1 = commitOn(w.dev, 'Stable first change');
  const c2 = commitOn(w.dev, 'Change that will be amended');
  git(w.dev, 'push', '-q', 'origin', 'feat/rebase');
  w.ingest({ ref: 'refs/heads/feat/rebase', before: ZERO, after: c2 });

  git(w.dev, 'commit', '--amend', '--allow-empty', '-q', '-m', 'Amended second change');
  const c2b = head(w.dev);
  git(w.dev, 'push', '-q', '--force', 'origin', 'feat/rebase'); // developer-side rewrite; DocFlow never does this
  const res = w.ingest({ ref: 'refs/heads/feat/rebase', before: c2, after: c2b });
  assert.deepEqual(res.recorded, [c2b]);
  assert.deepEqual(w.fresh().tasks.find((t) => t.id === 'feat/rebase').commits.map((c) => c.sha), [c1, c2, c2b]);
});

test('invalid GitHub-side subjects warn visibly but are still ingested', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/warn');
  const good = commitOn(w.dev, 'Add a specific change');
  const bad = commitOn(w.dev, 'wip');
  git(w.dev, 'push', '-q', 'origin', 'feat/warn');
  const res = w.ingest({ ref: 'refs/heads/feat/warn', before: ZERO, after: bad });
  assert.deepEqual(res.recorded, [good, bad]);
  assert.equal(res.warnings.length, 1);
  assert.equal(res.warnings[0].sha, bad);
  assert.equal(res.warnings[0].problems[0].code === 'subject-too-short' || res.warnings[0].problems.some((p) => p.code === 'placeholder'), true);
  assert.equal(git(w.dev, 'rev-parse', 'origin/feat/warn'), bad, 'published history untouched');
});

test('baseline, docflow-state and deleted-branch pushes never become progress', () => {
  const w = world();
  const tip = head(w.dev);
  for (const ref of ['refs/heads/main', 'refs/heads/master', 'refs/heads/docflow-state', 'refs/tags/v1']) {
    const res = w.ingest({ ref, before: ZERO, after: tip });
    assert.equal(res.skipped, true, ref);
  }
  assert.equal(w.ingest({ ref: 'refs/heads/feat/gone', before: tip, after: ZERO, deleted: true }).skipped, true);
  assert.equal(w.fresh().tasks.length, 0);
});

test('branch deletion after ingestion keeps durable progress', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/delete-me');
  const c1 = commitOn(w.dev, 'Soon to be deleted branch');
  git(w.dev, 'push', '-q', 'origin', 'feat/delete-me');
  w.ingest({ ref: 'refs/heads/feat/delete-me', before: ZERO, after: c1 });
  git(w.dev, 'push', '-q', 'origin', '--delete', 'feat/delete-me');
  w.ingest({ ref: 'refs/heads/feat/delete-me', before: c1, after: ZERO, deleted: true });
  assert.equal(w.fresh().tasks.find((t) => t.id === 'feat/delete-me').commits.length, 1);
});

function prPayload({ number = 7, branch, sha, state = 'open', merged = false, extra = {} }) {
  return {
    repository: { default_branch: 'main' },
    pull_request: {
      number, state, merged, title: `PR ${number}`, html_url: `https://example.test/pr/${number}`,
      merged_at: merged ? '2026-10-02T10:00:00Z' : null, closed_at: state === 'closed' ? '2026-10-02T10:00:00Z' : null,
      head: { ref: branch, sha, repo: { full_name: 'o/r' } }, base: { ref: 'main', repo: { full_name: 'o/r' } },
      ...extra,
    },
  };
}

test('PR opened then merged updates the same branch unit; fork PRs are ignored', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/pr');
  const c1 = commitOn(w.dev, 'Work that gets a PR');
  git(w.dev, 'push', '-q', 'origin', 'feat/pr');
  const r = w.runner();
  const opened = ingestPullRequest({ cwd: r.root, homeDir: r.home, payload: prPayload({ branch: 'feat/pr', sha: c1 }) });
  assert.deepEqual(opened.recorded, [c1]);
  let unit = w.fresh().tasks.find((t) => t.id === 'feat/pr');
  assert.equal(unit.pr.number, 7);
  assert.equal(unit.status, 'In progress');

  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--ff-only', 'feat/pr');
  git(w.dev, 'push', '-q', 'origin', 'main');
  const r2 = w.runner();
  ingestPullRequest({ cwd: r2.root, homeDir: r2.home, payload: prPayload({ branch: 'feat/pr', sha: c1, state: 'closed', merged: true }) });
  unit = w.fresh().tasks.find((t) => t.id === 'feat/pr');
  assert.equal(unit.status, 'Completed');
  assert.equal(unit.outcome, 'Merged');
  assert.equal(unit.commits.length, 1);

  const fork = prPayload({ branch: 'feat/fork', sha: c1, extra: { head: { ref: 'feat/fork', sha: c1, repo: { full_name: 'evil/r' } } } });
  assert.equal(ingestPullRequest({ cwd: r2.root, homeDir: r2.home, payload: fork }).skipped, true);
});

test('out-of-order events: merged PR arrives first, delayed push and opened events cannot reopen it or lose commits', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/order');
  const c1 = commitOn(w.dev, 'First ordered change');
  git(w.dev, 'push', '-q', 'origin', 'feat/order');
  w.ingest({ ref: 'refs/heads/feat/order', before: ZERO, after: c1 });
  const c2 = commitOn(w.dev, 'Late delivered change');
  git(w.dev, 'push', '-q', 'origin', 'feat/order');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--ff-only', 'feat/order');
  git(w.dev, 'push', '-q', 'origin', 'main');

  const r = w.runner();
  ingestPullRequest({ cwd: r.root, homeDir: r.home, payload: prPayload({ number: 9, branch: 'feat/order', sha: c2, state: 'closed', merged: true }) });
  // Delayed events: the push for c2 and a stale "opened" for the same PR.
  w.ingest({ ref: 'refs/heads/feat/order', before: c1, after: c2 });
  const r2 = w.runner();
  ingestPullRequest({ cwd: r2.root, homeDir: r2.home, payload: prPayload({ number: 9, branch: 'feat/order', sha: c1 }) });
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/order');
  assert.deepEqual(unit.commits.map((c) => c.sha), [c1, c2]);
  assert.equal(unit.status, 'Completed');
  assert.equal(unit.outcome, 'Merged');
});

test('closed-without-merge PR marks the unit abandoned', () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/closed');
  const c1 = commitOn(w.dev, 'Work that is dropped');
  git(w.dev, 'push', '-q', 'origin', 'feat/closed');
  const r = w.runner();
  ingestPullRequest({ cwd: r.root, homeDir: r.home, payload: prPayload({ number: 3, branch: 'feat/closed', sha: c1, state: 'closed' }) });
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/closed');
  assert.equal(unit.status, 'Abandoned');
  assert.equal(unit.outcome, 'Closed without merge');
});

function runCli(args, cwd, home) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--cwd', cwd], { env: { ...process.env, HOME: home }, stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => resolve({ code, err }));
  });
}

test('concurrent runners ingesting the same push (separate processes) record each SHA exactly once', async () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/race');
  const shas = [commitOn(w.dev, 'Raced change one'), commitOn(w.dev, 'Raced change two')];
  git(w.dev, 'push', '-q', 'origin', 'feat/race');
  const args = ['ingest-push', '--ref', 'refs/heads/feat/race', '--before', ZERO, '--after', shas[1], '--default-branch', 'main'];
  const results = await Promise.all([1, 2, 3].map(() => {
    const r = w.runner();
    return runCli(args, r.root, r.home);
  }));
  for (const r of results) assert.equal(r.code, 0, r.err);
  const unit = w.fresh().tasks.find((t) => t.id === 'feat/race');
  assert.deepEqual(unit.commits.map((c) => c.sha), shas);
  assert.equal(w.fresh().tasks.length, 1);
});

test('ingest-github CLI reads a push event payload, emits warnings and a step summary', async () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/cli');
  const sha = commitOn(w.dev, 'update');
  git(w.dev, 'push', '-q', 'origin', 'feat/cli');
  const r = w.runner();
  const eventPath = path.join(r.home, 'event.json');
  const summary = path.join(r.home, 'summary.md');
  fs.writeFileSync(eventPath, JSON.stringify({ ref: 'refs/heads/feat/cli', before: ZERO, after: sha, repository: { default_branch: 'main' } }));
  const out = await new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, 'ingest-github', '--event-name', 'push', '--event-path', eventPath, '--cwd', r.root], {
      env: { ...process.env, HOME: r.home, GITHUB_STEP_SUMMARY: summary }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', (code) => resolve({ code, stdout }));
  });
  assert.equal(out.code, 0);
  assert.match(out.stdout, /::warning title=DocFlow commit message::/);
  assert.match(fs.readFileSync(summary, 'utf8'), /Commit message warnings/);
  assert.deepEqual(w.fresh().tasks.find((t) => t.id === 'feat/cli').commits.map((c) => c.sha), [sha]);
});

test('workflow template is a thin least-privilege caller that cannot recurse on docflow-state', () => {
  const yml = renderWorkflow();
  assert.ok(yml.startsWith(WORKFLOW_MARKER));
  assert.match(yml, /branches-ignore: \[main, master, docflow-state\]/);
  assert.match(yml, /permissions:\n  contents: write\n/);
  assert.doesNotMatch(yml, /pull_request_target/);
  assert.doesNotMatch(yml, /^concurrency:/m, 'a concurrency group would let GitHub cancel queued runs and drop events');
  assert.doesNotMatch(yml, /secrets\./);
  assert.match(yml, /head\.repo\.full_name == github\.repository/);
  assert.match(yml, /uses: Jiaze-Li\/DocFlow\/action@main/);
  assert.equal((yml.match(/run:/g) || []).length, 0, 'no logic duplicated in the repository workflow');
});

test('setup-repo installs hook + workflow + activation, and is idempotent', () => {
  const w = world({ activate: false });
  const first = setupRepo({ cwd: w.dev, homeDir: w.home });
  assert.equal(first.hook.changed, true);
  assert.equal(first.workflow.changed, true);
  assert.equal(first.activation.created, true);
  const second = setupRepo({ cwd: w.dev, homeDir: w.home });
  assert.equal(second.hook.changed, false);
  assert.equal(second.workflow.changed, false);
  assert.equal(second.activation.created, false);
});

test('doctor reports missing/stale commit-native integration once activated, and only info before', async () => {
  const { doctor } = await import('../src/doctor.js');
  const byName = (r) => Object.fromEntries(r.checks.map((c) => [c.name, c]));

  const w = world({ activate: false });
  let c = byName(doctor({ cwd: w.dev, homeDir: w.home }));
  assert.equal(c.commit_hook.ok, true);
  assert.equal(c.commit_hook.info, true);
  assert.match(c.commit_native.detail, /not activated/);

  setupRepo({ cwd: w.dev, homeDir: w.home });
  c = byName(doctor({ cwd: w.dev, homeDir: w.home }));
  for (const name of ['durable_state', 'commit_hook', 'github_workflow']) assert.equal(c[name].ok, true, name);
  assert.match(c.commit_native.detail, /active since/);

  fs.rmSync(path.join(w.dev, '.github', 'workflows', 'docflow.yml'));
  const hook = git(w.dev, 'rev-parse', '--git-path', 'hooks/commit-msg');
  fs.writeFileSync(path.resolve(w.dev, hook), '#!/bin/sh\n# DOCFLOW-COMMIT-MSG-HOOK v1\nexit 0\n', { mode: 0o755 });
  c = byName(doctor({ cwd: w.dev, homeDir: w.home }));
  assert.equal(c.github_workflow.ok, false);
  assert.match(c.github_workflow.detail, /missing/);
  assert.equal(c.commit_hook.ok, false);
  assert.match(c.commit_hook.detail, /stale/);
});

test('same-branch race: a push run and a merged-PR run executing at the same time both land', async () => {
  const w = world();
  git(w.dev, 'checkout', '-q', '-b', 'feat/samerace');
  const c1 = commitOn(w.dev, 'Raced branch first');
  git(w.dev, 'push', '-q', 'origin', 'feat/samerace');
  w.ingest({ ref: 'refs/heads/feat/samerace', before: ZERO, after: c1 });
  const c2 = commitOn(w.dev, 'Raced branch second');
  git(w.dev, 'push', '-q', 'origin', 'feat/samerace');
  git(w.dev, 'checkout', '-q', 'main');
  git(w.dev, 'merge', '-q', '--ff-only', 'feat/samerace');
  git(w.dev, 'push', '-q', 'origin', 'main');

  for (let round = 0; round < 3; round += 1) {
    const pushRunner = w.runner();
    const prRunner = w.runner();
    const pushEvent = path.join(pushRunner.home, 'push.json');
    const prEvent = path.join(prRunner.home, 'pr.json');
    fs.writeFileSync(pushEvent, JSON.stringify({ ref: 'refs/heads/feat/samerace', before: c1, after: c2, repository: { default_branch: 'main' } }));
    fs.writeFileSync(prEvent, JSON.stringify(prPayload({ number: 11, branch: 'feat/samerace', sha: c2, state: 'closed', merged: true })));
    const run = (runner, name, file) => new Promise((resolve) => {
      const child = spawn(process.execPath, [CLI, 'ingest-github', '--event-name', name, '--event-path', file, '--cwd', runner.root], {
        env: { ...process.env, HOME: runner.home }, stdio: ['ignore', 'pipe', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (d) => { err += d; });
      child.on('close', (code) => resolve({ code, err }));
    });
    const results = await Promise.all([run(pushRunner, 'push', pushEvent), run(prRunner, 'pull_request', prEvent)]);
    for (const r of results) assert.equal(r.code, 0, r.err);
    if (round === 0) {
      const unit = w.fresh().tasks.find((t) => t.id === 'feat/samerace');
      assert.deepEqual(unit.commits.map((c) => c.sha), [c1, c2]);
      assert.equal(unit.status, 'Completed');
      assert.equal(unit.outcome, 'Merged');
      assert.equal(unit.pr.number, 11);
    }
  }
  assert.equal(w.fresh().tasks.length, 1);
});
