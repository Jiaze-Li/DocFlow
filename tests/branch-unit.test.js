import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
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

  // Create git branch with a commit beyond main
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feature/auth-recovery']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Feature work']);

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

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/auth']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Initial commit for auth']);
  const commitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const commit1 = {
    sha: commitSha,
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

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/auth-retry']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Add auth retry logic']);
  const commitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const commit1 = {
    sha: commitSha,
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

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/pipeline']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit 1: Setup schema']);
  const sha1 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit 2: Implement handlers']);
  const sha2 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit 3: Add integration tests']);
  const sha3 = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const commit1 = {
    sha: sha1,
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Commit 1: Setup schema',
  };

  const commit2 = {
    sha: sha2,
    timestamp: '2026-10-01T13:00:00.000Z',
    message: 'Commit 2: Implement handlers',
  };

  const commit3 = {
    sha: sha3,
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

test('recordCommitProgress enforces repository-wide SHA deduplication across branches and normalizes SHA case and short SHA', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/branch-a']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Base commit on branch A']);
  const commitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Test recording with short SHA (first 8 hex chars)
  const shortSha = commitSha.slice(0, 8);
  const commit1 = {
    sha: shortSha,
    timestamp: '2026-10-01T10:00:00.000Z',
    message: 'Base commit on branch A',
  };

  const res1 = recordCommitProgress({ cwd: repo, branch: 'feat/branch-a', commit: commit1 });
  assert.equal(res1.created, true);
  assert.equal(res1.alreadyRecorded, false);
  assert.equal(res1.commit.sha, commitSha.toLowerCase()); // Resolved to full SHA

  // Push same commit using full SHA (uppercase) to branch B (e.g. branch cut from branch A)
  const commit2 = {
    sha: commitSha.toUpperCase(),
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
  execFileSync('git', ['-C', repo, 'checkout', '-qb', longBranch]);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Long branch commit']);

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

  // Create branch in git with a commit so it represents a real development branch
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/pr-test']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'PR branch work']);

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

test('recordPullRequestEvent ignores branches that do not exist or have no unique commits', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // 1. Branch does not exist in git
  const resMissing = recordPullRequestEvent({
    cwd: repo,
    branch: 'feat/non-existent',
    pr: { number: 1, title: 'Ghost PR', state: 'open' },
  });
  assert.equal(resMissing.ignored, true);
  assert.match(resMissing.reason, /does not exist in git/);

  // 2. Branch exists in git but points to master/base without unique commits
  execFileSync('git', ['-C', repo, 'branch', 'feat/empty-branch', 'HEAD']);
  const resEmpty = recordPullRequestEvent({
    cwd: repo,
    branch: 'feat/empty-branch',
    pr: { number: 2, title: 'Empty PR', state: 'open' },
  });
  assert.equal(resEmpty.ignored, true);
  assert.match(resEmpty.reason, /reachable from base branch/);

  // Durable state must remain empty (no empty units created)
  const state = loadState(repo);
  assert.equal(state.tasks.length, 0);
});

test('deterministic interleaving CAS race for identical commit SHA returns alreadyRecorded', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  initRepo({ cwd: repo, homeDir: home, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/race-sha']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Concurrent webhook payload commit']);
  const commitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Different commit payload']);
  const differentSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  const commit = {
    sha: commitSha,
    timestamp: '2026-10-01T14:30:00.000Z',
    message: 'Concurrent webhook payload commit',
  };

  // Interleaving simulation:
  // Delivery 2 initiates while the unit and commit do not exist in state yet.
  // Delivery 2's pre-lock check finds nothing in state.
  // When Delivery 2 enters writeTaskUnit to commit, Delivery 1 commits the same commit first,
  // causing Delivery 2 to experience an actual CAS mismatch in commitStateFiles.
  // Delivery 2's catch block intercepts the CAS conflict, re-reads state, discovers
  // that commitSha is now recorded, and recovers cleanly with alreadyRecorded: true.
  let delivery1Committed = false;
  let casConflictTriggered = false;

  const interleavingCasExec = (cmd, args, opts) => {
    if (cmd === 'git' && Array.isArray(args) && args.includes('rev-parse')) {
      const target = args[args.length - 1];
      if (typeof target === 'string' && target.endsWith(':.docflow/units/feat%2Frace-sha.json')) {
        // Target in commitStateFiles check is `${parent}:.docflow/units/feat%2Frace-sha.json`
        if (!args.includes('refs/heads/docflow-state')) {
          delivery1Committed = true;
          // Delivery 1 commits commitSha in the background
          recordCommitProgress({ cwd: repo, homeDir: home, branch: 'feat/race-sha', commit });
          // Return a mismatched revision so Delivery 2's writeTaskUnit hits actual CAS conflict
          casConflictTriggered = true;
          return 'stale-mismatched-revision\n';
        }
      }
    }
    return execFileSync(cmd, args, opts);
  };

  const res2 = recordCommitProgress({
    cwd: repo,
    homeDir: home,
    branch: 'feat/race-sha',
    commit,
    exec: interleavingCasExec,
  });

  assert.equal(delivery1Committed, true);
  assert.equal(casConflictTriggered, true);
  assert.equal(res2.created, false);
  assert.equal(res2.alreadyRecorded, true);

  // Test that when a DIFFERENT commit encounters a real CAS conflict and the SHA is NOT in state,
  // recordCommitProgress re-throws the true CAS conflict error.
  let revParseCountB = 0;
  const casConflictWithNewShaExec = (cmd, args, opts) => {
    if (cmd === 'git' && Array.isArray(args) && args.includes('rev-parse')) {
      const target = args[args.length - 1];
      if (typeof target === 'string' && target.endsWith(':.docflow/units/feat%2Frace-sha.json')) {
        revParseCountB++;
        if (revParseCountB === 3) {
          return 'stale-mismatched-revision\n';
        }
      }
    }
    return execFileSync(cmd, args, opts);
  };

  const differentCommit = {
    sha: differentSha,
    timestamp: '2026-10-01T14:35:00.000Z',
    message: 'Different commit payload',
  };

  assert.throws(
    () => recordCommitProgress({
      cwd: repo,
      homeDir: home,
      branch: 'feat/race-sha',
      commit: differentCommit,
      exec: casConflictWithNewShaExec,
    }),
    /DocFlow durable state changed concurrently for/
  );

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

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/branch-alpha']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Cross-branch commit payload']);
  const commitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  execFileSync('git', ['-C', repo, 'branch', 'feat/branch-beta', 'HEAD']);

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

  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/conflict-test']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit A']);
  const shaA = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit B by other worker']);
  const shaB = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Commit C']);
  const shaC = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // First create a branch unit with commit A
  recordCommitProgress({
    cwd: repo,
    homeDir: home,
    branch: 'feat/conflict-test',
    commit: { sha: shaA, timestamp: '2026-10-01T10:00:00.000Z', message: 'Commit A' },
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
          commit: { sha: shaB, timestamp: '2026-10-01T10:05:00.000Z', message: 'Commit B by other worker' },
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
    commit: { sha: shaC, timestamp: '2026-10-01T10:10:00.000Z', message: 'Commit C' },
    exec: interleavingExec,
  });
  assert.equal(injected, true);
  assert.equal(resC.alreadyRecorded, false);

  // Verify that all commits [A, B, C] are preserved in order
  const state = loadState(repo);
  const task = state.tasks.find((t) => t.id === 'feat/conflict-test');
  assert.ok(task);
  assert.deepEqual(task.commits.map((c) => c.sha), [shaA, shaB, shaC]);
});

test('createBranchUnit skips creation when branch has no unique commits of its own', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // Create feat/base and make a commit beyond master
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feat/base']);
  execFileSync('git', ['-C', repo, 'commit', '--allow-empty', '-qm', 'Base feature commit']);
  const baseSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Record base commit on feat/base
  const commit1 = {
    sha: baseSha,
    timestamp: '2026-10-01T12:00:00.000Z',
    message: 'Base feature commit',
  };
  recordCommitProgress({ cwd: repo, branch: 'feat/base', commit: commit1 });

  // Create git branch feat/child cut from feat/base (whose tip is recorded on feat/base)
  execFileSync('git', ['-C', repo, 'branch', 'feat/child', 'feat/base'], { stdio: 'ignore' });

  // Now createBranchUnit for feat/child whose tip commit is already recorded in durable state
  const res = createBranchUnit({ cwd: repo, branch: 'feat/child' });
  assert.equal(res.created, false);
  assert.equal(res.task.id, 'feat/base');

  // Verify durable state still has only 1 task unit (no redundant unit created)
  const state = loadState(repo);
  assert.equal(state.tasks.length, 1);
  assert.equal(state.tasks[0].id, 'feat/base');
});

function runCommitProcess({ cwd, homeDir, branch, commit }) {
  const coreUrl = new URL('../src/core.js', import.meta.url).href;
  const script = [
    `import { recordCommitProgress } from ${JSON.stringify(coreUrl)};`,
    `const res = recordCommitProgress(${JSON.stringify({ cwd, homeDir, branch, commit })});`,
    `process.stdout.write(JSON.stringify(res));`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          resolve({ raw: stdout });
        }
      } else {
        reject(new Error(`commit child failed (${code}): ${stderr}`));
      }
    });
  });
}

test('multi-process concurrent deliveries across separate worktrees serialize cleanly under shared lock', async () => {
  const root = tempGitRepo();
  const parent = path.dirname(root);
  const wtAlpha = path.join(parent, `${path.basename(root)}-wt-alpha`);
  const wtBeta = path.join(parent, `${path.basename(root)}-wt-beta`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature/worker-alpha', wtAlpha, 'HEAD']);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'feature/worker-beta', wtBeta, 'HEAD']);

  const home = tempHome();
  initRepo({ cwd: root, homeDir: home, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // Add work in both worktrees
  execFileSync('git', ['-C', wtAlpha, 'commit', '--allow-empty', '-qm', 'Alpha worktree commit']);
  const shaAlpha = execFileSync('git', ['-C', wtAlpha, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  execFileSync('git', ['-C', wtBeta, 'commit', '--allow-empty', '-qm', 'Beta worktree commit']);
  const shaBeta = execFileSync('git', ['-C', wtBeta, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Concurrently deliver commits from distinct child processes targeting distinct worktrees
  const [resAlpha, resBeta] = await Promise.all([
    runCommitProcess({
      cwd: wtAlpha,
      homeDir: home,
      branch: 'feature/worker-alpha',
      commit: { sha: shaAlpha, timestamp: '2026-10-01T12:00:00.000Z', message: 'Alpha worktree commit' },
    }),
    runCommitProcess({
      cwd: wtBeta,
      homeDir: home,
      branch: 'feature/worker-beta',
      commit: { sha: shaBeta, timestamp: '2026-10-01T12:05:00.000Z', message: 'Beta worktree commit' },
    }),
  ]);

  assert.equal(resAlpha.created, true);
  assert.equal(resAlpha.alreadyRecorded, false);
  assert.equal(resBeta.created, true);
  assert.equal(resBeta.alreadyRecorded, false);

  const state = loadState(root);
  assert.equal(state.tasks.length, 2);
  const taskAlpha = state.tasks.find((t) => t.id === 'feature/worker-alpha');
  const taskBeta = state.tasks.find((t) => t.id === 'feature/worker-beta');
  assert.ok(taskAlpha);
  assert.ok(taskBeta);
  assert.equal(taskAlpha.commits[0].sha, shaAlpha);
  assert.equal(taskBeta.commits[0].sha, shaBeta);
});

test('recordCommitProgress ignores commits that are already reachable from main', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // Ensure 'main' branch exists pointing to HEAD (tempGitRepo may default to master)
  execFileSync('git', ['-C', repo, 'branch', 'main', 'HEAD']);

  // Commit on main
  const mainCommitSha = execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();

  // Create branch cut from main without new commits
  execFileSync('git', ['-C', repo, 'checkout', '-qb', 'feature/from-main']);

  // Attempt to record the main commit on the branch
  const res = recordCommitProgress({
    cwd: repo,
    branch: 'feature/from-main',
    commit: {
      sha: mainCommitSha,
      timestamp: '2026-10-01T12:00:00.000Z',
      message: 'Commit from main',
    },
  });

  assert.equal(res.ignored, true);
  assert.match(res.reason, /already reachable from (?:main|base)/);

  // State must not contain an empty or redundant unit
  const state = loadState(repo);
  assert.equal(state.tasks.length, 0);
});

test('recordCommitProgress rejects non-existent or invalid commit SHAs without creating durable branch units', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'TestRepo', obsidianNote: 'project - test.md' });

  // 1. Completely fictitious 40-character SHA that does not exist in git
  const resGhost = recordCommitProgress({
    cwd: repo,
    branch: 'feat/ghost-commit',
    commit: {
      sha: 'ffffffffffffffffffffffffffffffffffffffff',
      timestamp: '2026-10-01T12:00:00.000Z',
      message: 'Fictitious commit',
    },
  });
  assert.equal(resGhost.ignored, true);
  assert.match(resGhost.reason, /invalid or does not exist in git/);

  // 2. Fictitious short SHA that does not exist in git
  const resShortGhost = recordCommitProgress({
    cwd: repo,
    branch: 'feat/ghost-short',
    commit: {
      sha: 'deadbeef',
      timestamp: '2026-10-01T12:00:00.000Z',
      message: 'Short fictitious commit',
    },
  });
  assert.equal(resShortGhost.ignored, true);
  assert.match(resShortGhost.reason, /invalid or does not exist in git/);

  // Durable state must remain empty (no ghost units created)
  const state = loadState(repo);
  assert.equal(state.tasks.length, 0);
});
