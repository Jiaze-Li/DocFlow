import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import {
  createBranchUnit,
  getBranchUnit,
  initRepo,
  isDevelopmentBranch,
  loadState,
  recordCommitProgress,
  recordPullRequestEvent,
} from '../src/core.js';
import { tempGitRepo } from './helpers.js';

test('isDevelopmentBranch accurately filters branches', () => {
  assert.equal(isDevelopmentBranch('main'), false);
  assert.equal(isDevelopmentBranch('docflow-state'), false);
  assert.equal(isDevelopmentBranch('refs/heads/main'), false);
  assert.equal(isDevelopmentBranch('refs/heads/docflow-state'), false);
  assert.equal(isDevelopmentBranch('master'), true); // Contract: only main and docflow-state are excluded
  assert.equal(isDevelopmentBranch('feat/new-ui'), true);
  assert.equal(isDevelopmentBranch('fix/issue-123'), true);
  assert.equal(isDevelopmentBranch('refs/heads/fix/issue-123'), true);
  assert.equal(isDevelopmentBranch(''), false);
  assert.equal(isDevelopmentBranch(null), false);
});

test('createBranchUnit creates a unit for a development branch and is idempotent', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const res1 = createBranchUnit({ cwd: repo, branch: 'feature/auth-recovery' });
  assert.equal(res1.created, true);
  assert.equal(res1.task.id, 'feature/auth-recovery');
  assert.equal(res1.task.branch, 'feature/auth-recovery');
  assert.equal(res1.task.status, 'In progress');

  // Replay createBranchUnit
  const res2 = createBranchUnit({ cwd: repo, branch: 'feature/auth-recovery' });
  assert.equal(res2.created, false);
  assert.equal(res2.task.id, 'feature/auth-recovery');

  const state = loadState(repo);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'feature/auth-recovery');
});

test('createBranchUnit rejects non-development branches', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  assert.throws(() => createBranchUnit({ cwd: repo, branch: 'main' }), /not a development branch/);
  assert.throws(() => createBranchUnit({ cwd: repo, branch: 'docflow-state' }), /not a development branch/);
});

test('recordCommitProgress creates unit if missing and records progress', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commit1 = {
    sha: 'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4e5f6a1b2',
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Initial commit for auth',
  };

  const res = recordCommitProgress({ cwd: repo, branch: 'feat/auth', commit: commit1 });
  assert.equal(res.created, true);
  assert.equal(res.alreadyRecorded, false);
  assert.equal(res.task.id, 'feat/auth');
  assert.equal(res.task.current, 'Initial commit for auth');
  assert.equal(res.task.commits.length, 1);
  assert.equal(res.task.commits[0].sha, commit1.sha);

  const state = loadState(repo);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].commits[0].sha, commit1.sha);
});

test('recordCommitProgress is strictly idempotent on duplicate commit SHA replay', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commit1 = {
    sha: '1111111222222233333334444444555555566666',
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Add auth retry logic',
  };

  const res1 = recordCommitProgress({ cwd: repo, branch: 'feat/auth-retry', commit: commit1 });
  assert.equal(res1.created, true);
  assert.equal(res1.alreadyRecorded, false);

  // Replay exact same commit
  const res2 = recordCommitProgress({ cwd: repo, branch: 'feat/auth-retry', commit: commit1 });
  assert.equal(res2.created, false);
  assert.equal(res2.alreadyRecorded, true);

  // Durable state must contain exactly one commit entry
  const state = loadState(repo);
  const task = state.tasks.find((t) => t.id === 'feat/auth-retry');
  assert.ok(task);
  assert.equal(task.commits.length, 1);
  assert.equal(task.commits[0].sha, commit1.sha);
  assert.equal(task.history.length, 0); // No history created for duplicate replay
});

test('recordCommitProgress records multiple commits on one branch preserving unit and appending in order', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commit1 = {
    sha: 'aaaaaa123456789012345678901234567890aaaa',
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Commit 1: Setup schema',
  };

  const commit2 = {
    sha: 'bbbbbb123456789012345678901234567890bbbb',
    timestamp: '2026-10-01T13:00:00.000Z',
    message: 'Commit 2: Implement handlers',
  };

  const commit3 = {
    sha: 'cccccc123456789012345678901234567890cccc',
    timestamp: '2026-10-01T14:00:00.000Z',
    message: 'Commit 3: Add integration tests',
    summary: 'Summary 3: Integration tests pass',
  };

  recordCommitProgress({ cwd: repo, branch: 'feat/pipeline', commit: commit1 });
  recordCommitProgress({ cwd: repo, branch: 'feat/pipeline', commit: commit2 });
  recordCommitProgress({ cwd: repo, branch: 'feat/pipeline', commit: commit3 });

  const state = loadState(repo);
  assert.equal(state.tasks.length, 1);
  const task = state.tasks[0];
  assert.equal(task.id, 'feat/pipeline');
  assert.equal(task.commits.length, 3);
  assert.deepEqual(task.commits.map((c) => c.sha), [commit1.sha, commit2.sha, commit3.sha]);
  assert.equal(task.current, 'Summary 3: Integration tests pass');
  assert.deepEqual(task.history.map((h) => h.text), [
    'Commit 1: Setup schema',
    'Commit 2: Implement handlers',
  ]);
});

test('recordCommitProgress ignores non-development branches', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const res = recordCommitProgress({
    cwd: repo,
    branch: 'main',
    commit: { sha: '1234567890abcdef1234567890abcdef12345678', timestamp: '2026-10-01T10:00:00.000Z', message: 'Main push' },
  });
  assert.equal(res.ignored, true);

  const state = loadState(repo);
  assert.equal(state.tasks.length, 0);
});

test('recordCommitProgress enforces repository-wide SHA deduplication across branches and normalizes SHA case', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commitSha = 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4E5F6A1B2';
  const commit1 = {
    sha: commitSha,
    timestamp: '2026-10-01T10:00:00.000Z',
    message: 'Base commit on branch A',
  };

  const res1 = recordCommitProgress({ cwd: repo, branch: 'feat/branch-a', commit: commit1 });
  assert.equal(res1.created, true);
  assert.equal(res1.alreadyRecorded, false);
  assert.equal(res1.commit.sha, commitSha.toLowerCase());

  // Push same commit (lowercase) to branch B (e.g. branch cut from branch A)
  const commit2 = {
    sha: commitSha.toLowerCase(),
    timestamp: '2026-10-01T11:00:00.000Z',
    message: 'Duplicate commit on branch B',
  };
  const res2 = recordCommitProgress({ cwd: repo, branch: 'feat/branch-b', commit: commit2 });
  assert.equal(res2.created, false);
  assert.equal(res2.alreadyRecorded, true);
  assert.equal(res2.task.id, 'feat/branch-a');

  // Verify only one unit recorded that commit
  const state = loadState(repo);
  const allCommits = state.tasks.flatMap((t) => t.commits || []);
  assert.equal(allCommits.length, 1);
  assert.equal(allCommits[0].sha, commitSha.toLowerCase());
});

test('supports branch names up to 200 characters without validation errors', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const longBranch = 'feature/' + 'a'.repeat(150);
  const res = createBranchUnit({ cwd: repo, branch: longBranch });
  assert.equal(res.created, true);
  assert.equal(res.task.id, longBranch);
  assert.equal(res.task.branch, longBranch);

  const state = loadState(repo);
  assert.equal(state.tasks[0].id, longBranch);
});

test('recordPullRequestEvent merges PR metadata and handles out-of-order events safely', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const prEvent1 = {
    number: 42,
    title: 'PR Title',
    state: 'closed',
    merged: true,
    mergedAt: '2026-10-01T15:00:00.000Z',
  };
  const res1 = recordPullRequestEvent({ cwd: repo, branch: 'feat/pr-test', pr: prEvent1 });
  assert.equal(res1.task.status, 'Completed');
  assert.equal(res1.task.outcome, 'Merged');

  // Replay an earlier or out-of-order 'opened' webhook without merged=true
  const prEvent2 = {
    number: 42,
    title: 'PR Title',
    state: 'open',
  };
  const res2 = recordPullRequestEvent({ cwd: repo, branch: 'feat/pr-test', pr: prEvent2 });
  assert.equal(res2.task.status, 'Completed');
  assert.equal(res2.task.outcome, 'Merged');
  assert.equal(res2.task.pr.merged, true);
});

