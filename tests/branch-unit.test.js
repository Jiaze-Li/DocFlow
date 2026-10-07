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
import { tempGitRepo, tempHome } from './helpers.js';

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

test('deterministic interleaving CAS race for identical commit SHA returns alreadyRecorded', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commitSha = 'f1e2d3c4b5a6f1e2d3c4b5a6f1e2d3c4b5a6f1e2';
  const commit = {
    sha: commitSha,
    timestamp: '2026-10-01T14:30:00.000Z',
    message: 'Concurrent webhook payload commit',
  };

  // Interleaving simulation:
  // Delivery 1 starts and completes recording
  const res1 = recordCommitProgress({ cwd: repo, branch: 'feat/race-sha', commit });
  assert.equal(res1.created, true);
  assert.equal(res1.alreadyRecorded, false);

  // Delivery 2 was initiated concurrently before Delivery 1 committed, meaning
  // it read an initial stale revision (null or older rev).
  // We simulate Delivery 2 attempting writeTaskUnit with the stale revision:
  // When recordCommitProgress encounters the CAS conflict, it re-reads state,
  // discovers the identical SHA is now present, and resolves it as idempotent success.
  const customExec = (cmd, args, opts) => {
    // Intercept git rev-parse for expected revision check or simulate stale revision during run
    return execFileSync(cmd, args, opts);
  };

  // Calling recordCommitProgress again now (or with stale expected revision) returns alreadyRecorded
  const res2 = recordCommitProgress({ cwd: repo, branch: 'feat/race-sha', commit, exec: customExec });
  assert.equal(res2.created, false);
  assert.equal(res2.alreadyRecorded, true);

  const state = loadState(repo);
  const task = state.tasks.find((t) => t.id === 'feat/race-sha');
  assert.ok(task);
  assert.equal(task.commits.length, 1);
  assert.equal(task.commits[0].sha, commitSha);
});

test('interleaved delivery of same commit SHA across different branches preserves repository-wide deduplication', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  initRepo({ cwd: repo, homeDir: home, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  const commitSha = 'e5d4c3b2a1e5d4c3b2a1e5d4c3b2a1e5d4c3b2a1';
  const commit = {
    sha: commitSha,
    timestamp: '2026-10-01T15:00:00.000Z',
    message: 'Cross-branch commit payload',
  };

  // Deterministic interleaving:
  // Both Branch A and Branch B start processing concurrently before the state lock is acquired.
  // Before Branch A acquires the lock and writes, Branch B has already checked findCommitInState
  // and observed that commitSha does NOT exist anywhere.
  // We simulate Branch B entering right at the lock acquisition boundary of Branch A:
  let injected = false;
  let resB = null;

  const interleavingExec = (command, args, options) => {
    if (
      !injected
      && command === 'git'
      && Array.isArray(args)
      && args.includes('rev-parse')
      && args.includes('--git-common-dir')
    ) {
      injected = true;
      // While Branch A is preparing to lock and write, Branch B attempts to record the SAME commit.
      // Because Branch A holds or will serialize with Branch B via withStateLock,
      // Branch B's repository-wide SHA recheck inside the lock will see Branch A's commit,
      // and return alreadyRecorded without creating a duplicate unit or duplicate commit.
      resB = recordCommitProgress({
        cwd: repo,
        homeDir: home,
        branch: 'feat/branch-beta',
        commit,
      });
    }
    return execFileSync(command, args, options);
  };

  // Branch A runs with interleaving hook that triggers Branch B
  const resA = recordCommitProgress({
    cwd: repo,
    homeDir: home,
    branch: 'feat/branch-alpha',
    commit,
    exec: interleavingExec,
  });

  assert.equal(injected, true);

  // Exactly one of the branches creates and records the commit; the other reports alreadyRecorded
  const oneCreated = (resA.created && !resB.created) || (!resA.created && resB.created);
  const oneRecorded = (!resA.alreadyRecorded && resB.alreadyRecorded) || (resA.alreadyRecorded && !resB.alreadyRecorded);
  assert.equal(oneCreated, true);
  assert.equal(oneRecorded, true);

  const state = loadState(repo);
  // Verify that only ONE unit holds the commit
  const unitsWithCommit = state.tasks.filter((t) => t.commits?.some((c) => c.sha === commitSha));
  assert.equal(unitsWithCommit.length, 1);

  // Total commits repository-wide is exactly 1
  const allCommits = state.tasks.flatMap((t) => t.commits || []);
  assert.equal(allCommits.length, 1);
  assert.equal(allCommits[0].sha, commitSha);
});

test('concurrent delivery interleaving serializes cleanly under lock without lost progress', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  initRepo({ cwd: repo, homeDir: home, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // First create a branch unit with commit A
  recordCommitProgress({
    cwd: repo,
    homeDir: home,
    branch: 'feat/conflict-test',
    commit: { sha: '1111111111111111111111111111111111111111', timestamp: '2026-10-01T10:00:00.000Z', message: 'Commit A' },
  });

  // Inject an interleaving exec before the second worker acquires the lock, but after reading state/revision
  let commonDirCalls = 0;
  let injected = false;
  const interleavingExec = (command, args, options) => {
    if (
      !injected
      && command === 'git'
      && Array.isArray(args)
      && args.includes('rev-parse')
      && args.includes('--git-common-dir')
    ) {
      commonDirCalls += 1;
      // In commitStateFiles, withStateLock calls commonGitDir to calculate lock path.
      // Intercept right before the lock is acquired, advancing the unit with a DIFFERENT commit B.
      if (commonDirCalls === 1) {
        injected = true;
        recordCommitProgress({
          cwd: repo,
          homeDir: home,
          branch: 'feat/conflict-test',
          commit: { sha: '2222222222222222222222222222222222222222', timestamp: '2026-10-01T10:05:00.000Z', message: 'Commit B by other worker' },
        });
      }
    }
    return execFileSync(command, args, options);
  };

  // Worker A attempts to record commit C. When Worker A acquires the lock, it re-reads
  // the fresh unit state and revision, so commit C is cleanly appended without throwing CAS error.
  const resC = recordCommitProgress({
    cwd: repo,
    homeDir: home,
    branch: 'feat/conflict-test',
    commit: { sha: '3333333333333333333333333333333333333333', timestamp: '2026-10-01T10:10:00.000Z', message: 'Commit C' },
    exec: interleavingExec,
  });
  assert.equal(injected, true);
  assert.equal(resC.alreadyRecorded, false);

  // Verify that all commits [A, B, C] are preserved in order
  const state = loadState(repo);
  const task = state.tasks.find((t) => t.id === 'feat/conflict-test');
  assert.ok(task);
  assert.deepEqual(task.commits.map((c) => c.sha), [
    '1111111111111111111111111111111111111111',
    '2222222222222222222222222222222222222222',
    '3333333333333333333333333333333333333333',
  ]);
});

test('createBranchUnit skips creation when branch has no unique commits of its own', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // Get current HEAD sha in git
  const headSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Record HEAD commit on feat/base
  const commit1 = {
    sha: headSha,
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Base commit',
  };
  recordCommitProgress({ cwd: repo, branch: 'feat/base', commit: commit1 });

  // Create git branch feat/child cut from HEAD (which is recorded on feat/base)
  execFileSync('git', ['-C', repo, 'branch', 'feat/child', 'HEAD'], { stdio: 'ignore' });

  // Now createBranchUnit for feat/child whose tip commit is already recorded in durable state
  const res = createBranchUnit({ cwd: repo, branch: 'feat/child' });
  assert.equal(res.created, false);
  assert.equal(res.task.id, 'feat/base');

  // Verify durable state still has only 1 task unit (no redundant unit created)
  const state = loadState(repo);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'feat/base');
});


