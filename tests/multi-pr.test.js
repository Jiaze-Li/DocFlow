import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { initRepo, loadState, recordPullRequestEvent, renderTaskUnit } from '../src/core.js';
import { tempGitRepo } from './helpers.js';

const url = (n) => `https://github.com/Jiaze-Li/DocFlow/pull/${n}`;
const open = (n, updatedAt) => ({ number: n, title: `PR ${n}`, state: 'open', url: url(n), updatedAt });
const merged = (n, at) => ({ number: n, title: `PR ${n}`, state: 'closed', merged: true, mergedAt: at, updatedAt: at, url: url(n) });

function setup() {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'work/reused']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Reused branch work']);
  return repo;
}
const record = (repo, pr, action) => recordPullRequestEvent({ cwd: repo, branch: 'work/reused', pr, action });

test('a reused branch keeps every pull request and restarts the lifecycle for each new one', () => {
  const repo = setup();
  record(repo, open(16, '2026-10-01T01:00:00.000Z'));
  let task = record(repo, merged(16, '2026-10-01T02:00:00.000Z')).task;
  assert.equal(task.status, 'Completed');
  assert.equal(task.pr.number, 16);

  // The same branch is used for the next pull request: the unit is active again.
  task = record(repo, open(17, '2026-10-02T01:00:00.000Z')).task;
  assert.equal(task.status, 'In progress');
  assert.equal(task.outcome, null);
  assert.equal(task.completed, null);
  assert.equal(task.pr.number, 17);
  assert.notEqual(task.pr.merged, true);
  assert.deepEqual(task.prs.map((p) => [p.number, p.merged]), [[16, true]]);

  task = record(repo, merged(17, '2026-10-02T02:00:00.000Z')).task;
  assert.equal(task.status, 'Completed');
  assert.equal(task.pr.merged, true);
  assert.deepEqual(task.prs.map((p) => p.number), [16]);

  task = record(repo, open(18, '2026-10-03T01:00:00.000Z')).task;
  assert.deepEqual(task.prs.map((p) => p.number), [17, 16]);
  assert.equal(loadState(repo).tasks[0].pr.number, 18);
});

test('a late event for an older pull request never disturbs the current one', () => {
  const repo = setup();
  record(repo, merged(16, '2026-10-01T02:00:00.000Z'));
  record(repo, open(17, '2026-10-02T01:00:00.000Z'));

  // 16's replayed "opened" and a duplicate "merged" arrive after 17 started.
  record(repo, open(16, '2026-10-01T01:00:00.000Z'));
  const task = record(repo, merged(16, '2026-10-01T02:00:00.000Z')).task;
  assert.equal(task.pr.number, 17);
  assert.equal(task.status, 'In progress');
  assert.deepEqual(task.prs.map((p) => [p.number, p.merged]), [[16, true]]);
});

test('Obsidian shows every pull request of a branch, newest first, with its state', () => {
  const repo = setup();
  record(repo, merged(16, '2026-10-01T02:00:00.000Z'));
  record(repo, merged(17, '2026-10-02T02:00:00.000Z'));
  record(repo, open(18, '2026-10-03T01:00:00.000Z'));
  const text = renderTaskUnit(loadState(repo).tasks[0]);
  assert.match(text, new RegExp(`\\*\\*PR:\\*\\* \\[#18\\]\\(${url(18)}\\) open · \\[#17\\]\\(${url(17)}\\) merged · \\[#16\\]\\(${url(16)}\\) merged`));
});

test('a branch with a single pull request renders exactly as before', () => {
  const repo = setup();
  record(repo, open(5, '2026-10-01T01:00:00.000Z'));
  assert.match(renderTaskUnit(loadState(repo).tasks[0]), new RegExp(`\\*\\*PR:\\*\\* \\[#5\\]\\(${url(5)}\\)\\n`));
});

test('a delayed opened/synchronize event cannot reopen an archived pull request', () => {
  const repo = setup();
  record(repo, open(16, '2026-10-01T01:00:00.000Z'));
  record(repo, { number: 16, title: 'PR 16', state: 'closed', merged: false, closedAt: '2026-10-01T03:00:00.000Z', updatedAt: '2026-10-01T03:00:00.000Z', url: url(16) });
  record(repo, open(17, '2026-10-02T01:00:00.000Z'));

  // 16 was closed without merging; a delayed "synchronize" from before the close arrives late.
  const result = record(repo, open(16, '2026-10-01T02:00:00.000Z'));
  assert.equal(result.ignored, true);
  let archived = loadState(repo).tasks[0].prs.find((p) => p.number === 16);
  assert.equal(archived.state, 'closed');
  assert.equal(archived.updatedAt, '2026-10-01T03:00:00.000Z');

  // Even without a usable timestamp, a closed PR is not silently reopened.
  record(repo, { number: 16, state: 'open', url: url(16) });
  archived = loadState(repo).tasks[0].prs.find((p) => p.number === 16);
  assert.equal(archived.state, 'closed');

  // A genuine, provably newer reopen is accepted.
  recordPullRequestEvent({ cwd: repo, branch: 'work/reused', action: 'reopened', pr: open(16, '2026-10-02T00:00:00.000Z') });
  archived = loadState(repo).tasks[0].prs.find((p) => p.number === 16);
  assert.equal(archived.state, 'open');
  assert.equal(loadState(repo).tasks[0].pr.number, 17);
});
