// Opt-in repository deployment: install one stable GitHub Actions entrypoint per branch.
// Uses isolated temporary worktrees, never rebases, force-pushes, or stages user files.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRepoConfig, resolveRepoRoot } from './core.js';
import { STATE_BRANCH } from './state-store.js';
import { activateCommitNative } from './ingest.js';
import { commitHookStatus, installCommitHook } from './hooks.js';
import { WORKFLOW_FILE, WORKFLOW_MARKER, renderWorkflow } from './github.js';

const MAX_BRANCHES = 500;
const GIT_OPTIONS = {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
};

function git(repo, args) {
  return String(execFileSync('git', ['-C', repo, ...args], GIT_OPTIONS)).trim();
}

function errorSummary(error) {
  return String(error?.stderr || error?.message || error).trim().split('\n').at(-1).slice(0, 400);
}

function remoteBranches(repo) {
  const branches = git(repo, ['ls-remote', '--heads', 'origin']).split('\n').filter(Boolean).map((line) => {
    const match = /^([0-9a-f]{40,64})\s+refs\/heads\/(.+)$/.exec(line.trim());
    if (!match) throw new Error('Unrecognized origin branch advertisement');
    return { name: match[2], sha: match[1] };
  }).filter(({ name }) => name !== STATE_BRANCH);
  if (!branches.length) throw new Error('No business branches found on origin');
  if (branches.length > MAX_BRANCHES) throw new Error(`Too many branches (>${MAX_BRANCHES}); refusing unbounded deployment`);
  return branches.sort((a, b) => a.name.localeCompare(b.name));
}

function worktreeBranches(repo) {
  const worktrees = new Map();
  let current = null;
  for (const line of git(repo, ['worktree', 'list', '--porcelain']).split('\n')) {
    if (line.startsWith('worktree ')) current = line.slice('worktree '.length);
    if (line.startsWith('branch refs/heads/') && current) {
      worktrees.set(line.slice('branch refs/heads/'.length), current);
    }
  }
  return worktrees;
}

function localBranchTip(repo, branch) {
  try {
    return git(repo, ['show-ref', '--verify', '--hash', `refs/heads/${branch}`]);
  } catch {
    return null;
  }
}

function checkedOutBranchProblem(repo, branch, worktree) {
  const localTip = localBranchTip(repo, branch.name);
  if (localTip && localTip !== branch.sha) {
    return 'Local branch differs from the remote tip; refusing to create a divergence';
  }
  if (worktree && git(worktree, ['status', '--porcelain', '--untracked-files=all'])) {
    return 'Local worktree has uncommitted or untracked files; clean it before deployment';
  }
  return null;
}

// Verify the remote tree before doing anything to a local checkout.
function remoteWorkflow(repo, sha) {
  const name = `${sha}:${WORKFLOW_FILE}`;
  try {
    const mode = git(repo, ['ls-tree', sha, '--', WORKFLOW_FILE]).split(/\s+/)[0];
    if (mode === '120000') throw new Error('Remote workflow is a symlink');
    return git(repo, ['show', name]) + '\n';
  } catch (error) {
    if (String(error.message).includes('Remote workflow is a symlink')) throw error;
    const existing = git(repo, ['ls-tree', sha, '--', WORKFLOW_FILE]);
    if (existing) throw error;
    return null;
  }
}

function existingWorkflow(worktree) {
  const root = path.join(worktree, '.github');
  const dir = path.join(root, 'workflows');
  const file = path.join(worktree, WORKFLOW_FILE);
  // Don't follow symlinks: this deploy command must never write outside its worktree.
  for (const candidate of [root, dir, file]) {
    try {
      if (fs.lstatSync(candidate).isSymbolicLink()) {
        throw new Error('Workflow location is a symlink; refusing to overwrite it');
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!fs.existsSync(file)) return null;
  const contents = fs.readFileSync(file, 'utf8');
  if (!contents.startsWith(WORKFLOW_MARKER)) {
    throw new Error('Existing workflow is not managed by DocFlow');
  }
  return contents;
}

function deployBranch(repo, branch, worktrees, workflow) {
  const active = worktrees.get(branch.name);
  try {
    const previous = remoteWorkflow(repo, branch.sha);
    if (previous === workflow) return { branch: branch.name, status: 'unchanged' };
    if (previous && !previous.startsWith(WORKFLOW_MARKER)) {
      return { branch: branch.name, status: 'blocked', reason: 'Existing workflow is not managed by DocFlow' };
    }
  } catch (error) {
    return { branch: branch.name, status: 'blocked', reason: errorSummary(error) };
  }
  const issue = checkedOutBranchProblem(repo, branch, active);
  if (issue) return { branch: branch.name, status: 'blocked', reason: issue };

  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-deploy-'));
  const checkout = path.join(temp, 'checkout');
  let attached = false;
  try {
    git(repo, ['worktree', 'add', '--detach', checkout, branch.sha]);
    attached = true;
    const previous = existingWorkflow(checkout);
    if (previous === workflow) return { branch: branch.name, status: 'unchanged' };

    const file = path.join(checkout, WORKFLOW_FILE);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, workflow);
    git(checkout, ['add', '--', WORKFLOW_FILE]);
    git(checkout, [
      '-c', 'user.name=DocFlow', '-c', 'user.email=docflow@users.noreply.github.com',
      'commit', '-m', 'Enable DocFlow progress ingestion',
    ]);
    const nextSha = git(checkout, ['rev-parse', 'HEAD']);
    // Ordinary, non-force push. If the remote advanced, Git rejects this write.
    git(checkout, ['push', 'origin', `HEAD:refs/heads/${branch.name}`]);
    const remoteSha = git(repo, ['ls-remote', '--heads', 'origin', `refs/heads/${branch.name}`]).split(/\s+/)[0];
    if (remoteSha !== nextSha) {
      return { branch: branch.name, status: 'blocked', reason: 'Remote branch verification failed after push' };
    }

    try {
      if (active) {
        // Only a clean checkout at the old tip is eligible; update without a merge commit.
        git(active, ['merge', '--ff-only', nextSha]);
      } else if (localBranchTip(repo, branch.name) === branch.sha) {
        // Keep an idle local main/feature branch current for future branches cut from it.
        git(repo, ['update-ref', `refs/heads/${branch.name}`, nextSha, branch.sha]);
      }
    } catch (error) {
      return {
        branch: branch.name, status: 'blocked',
        reason: `Remote deployed, but local branch needs a fast-forward: ${errorSummary(error)}`,
        remoteUpdated: true,
      };
    }
    return { branch: branch.name, status: 'deployed', commit: nextSha };
  } catch (error) {
    return { branch: branch.name, status: 'blocked', reason: errorSummary(error) };
  } finally {
    if (attached) {
      try { git(repo, ['worktree', 'remove', '--force', checkout]); } catch { /* best effort */ }
    }
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

/**
 * Enable the existing central DocFlow action on every remote business branch.
 * No repo source files are edited in place and already-correct branches are no-ops.
 * A blocked branch is reported; no branch is force-pushed or silently rewritten.
 */
export function deployRepo({ cwd = process.cwd(), homeDir = os.homedir(), actionRef } = {}) {
  const repo = resolveRepoRoot(cwd);
  // Preflight remote access and repository configuration before making any change.
  git(repo, ['remote', 'get-url', 'origin']);
  git(repo, ['fetch', '--no-tags', 'origin', '+refs/heads/*:refs/remotes/origin/*']);
  if (!loadRepoConfig(repo)) throw new Error('DocFlow is not initialized; run docflow init first');
  const branches = remoteBranches(repo);
  if (commitHookStatus({ cwd: repo }).state === 'foreign') {
    throw new Error('Existing commit-msg hook is not managed by DocFlow; refusing deployment');
  }

  const hook = installCommitHook({ cwd: repo });
  // Snapshot pre-existing branch tips before the first workflow commit can trigger ingestion.
  const activation = activateCommitNative({ cwd: repo, homeDir });
  const workflow = renderWorkflow({ ...(actionRef ? { actionRef } : {}) });
  const worktrees = worktreeBranches(repo);
  const results = branches.map((branch) => deployBranch(repo, branch, worktrees, workflow));
  return {
    repoRoot: repo,
    ok: results.every((item) => item.status !== 'blocked'),
    hookChanged: hook.changed,
    activationCreated: activation.created,
    deployed: results.filter((item) => item.status === 'deployed'),
    unchanged: results.filter((item) => item.status === 'unchanged').map((item) => item.branch),
    blocked: results.filter((item) => item.status === 'blocked'),
  };
}
