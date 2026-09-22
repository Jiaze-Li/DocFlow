import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const STATE_BRANCH = 'docflow-state';
export const STATE_REF = `refs/heads/${STATE_BRANCH}`;
export const REMOTE_STATE_REF = `refs/remotes/origin/${STATE_BRANCH}`;

function git(repoRoot, args, exec = execFileSync, {
  allowFailure = false, env = null, input = undefined,
} = {}) {
  try {
    return String(exec('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
      env: env ? { ...process.env, ...env } : process.env,
      input,
    }) ?? '');
  } catch (error) {
    if (allowFailure) return '';
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message;
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function revParse(repoRoot, ref, exec = execFileSync) {
  return git(repoRoot, ['rev-parse', '--verify', ref], exec, { allowFailure: true }).trim() || null;
}

export function stateReadRef(repoRoot, exec = execFileSync) {
  if (revParse(repoRoot, STATE_REF, exec)) return STATE_REF;
  if (revParse(repoRoot, REMOTE_STATE_REF, exec)) return REMOTE_STATE_REF;
  return null;
}

export function stateStoreStatus(repoRoot, exec = execFileSync) {
  const localCommit = revParse(repoRoot, STATE_REF, exec);
  const remoteCommit = revParse(repoRoot, REMOTE_STATE_REF, exec);
  return {
    branch: STATE_BRANCH,
    localCommit,
    remoteCommit,
    readRef: localCommit ? STATE_REF : (remoteCommit ? REMOTE_STATE_REF : null),
  };
}

export function ensureLocalStateRef(repoRoot, exec = execFileSync) {
  const local = revParse(repoRoot, STATE_REF, exec);
  if (local) return local;
  const remote = revParse(repoRoot, REMOTE_STATE_REF, exec);
  if (!remote) return null;
  git(repoRoot, ['update-ref', STATE_REF, remote], exec);
  return remote;
}

function originUrl(repoRoot, exec = execFileSync) {
  return git(repoRoot, ['remote', 'get-url', 'origin'], exec, { allowFailure: true }).trim() || null;
}

function isAncestor(repoRoot, ancestor, descendant, exec = execFileSync) {
  try {
    exec('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 32 * 1024 * 1024,
    });
    return true;
  } catch {
    return false;
  }
}

function refreshRemoteStateRef(repoRoot, exec = execFileSync) {
  if (!originUrl(repoRoot, exec)) return { configured: false, commit: null };

  const advertised = git(
    repoRoot,
    ['ls-remote', '--heads', 'origin', STATE_REF],
    exec,
  ).trim();
  if (!advertised) {
    const stale = revParse(repoRoot, REMOTE_STATE_REF, exec);
    if (stale) git(repoRoot, ['update-ref', '-d', REMOTE_STATE_REF, stale], exec);
    return { configured: true, commit: null };
  }

  const remoteCommit = advertised.split(/\s+/)[0];
  if (!/^[0-9a-f]{40}$/i.test(remoteCommit)) {
    throw new Error(`Invalid origin/${STATE_BRANCH} commit advertised by Git`);
  }

  const tracked = revParse(repoRoot, REMOTE_STATE_REF, exec);
  if (tracked !== remoteCommit) {
    git(
      repoRoot,
      ['fetch', '--no-tags', 'origin', `${STATE_REF}:${REMOTE_STATE_REF}`],
      exec,
    );
  }
  return { configured: true, commit: remoteCommit };
}

function synchronizeStateParent(repoRoot, exec = execFileSync) {
  const remote = refreshRemoteStateRef(repoRoot, exec);
  let local = revParse(repoRoot, STATE_REF, exec);

  if (!local && remote.commit) {
    git(repoRoot, ['update-ref', STATE_REF, remote.commit], exec);
    local = remote.commit;
  } else if (local && remote.commit && local !== remote.commit) {
    if (isAncestor(repoRoot, local, remote.commit, exec)) {
      git(repoRoot, ['update-ref', STATE_REF, remote.commit, local], exec);
      local = remote.commit;
    } else if (!isAncestor(repoRoot, remote.commit, local, exec)) {
      throw new Error(
        `DocFlow durable state diverged from origin/${STATE_BRANCH}; refusing to merge or force-push automatically`,
      );
    }
  }

  return { parent: local, remoteConfigured: remote.configured, remoteCommit: remote.commit };
}

function pushStateCommit(repoRoot, commit, exec = execFileSync) {
  if (!commit || !originUrl(repoRoot, exec)) return { pushed: false, remoteCommit: null };
  try {
    git(repoRoot, ['push', 'origin', `${commit}:${STATE_REF}`], exec);
  } catch (error) {
    throw new Error(
      `DocFlow durable state push failed; local state was not advanced. `
      + `The remote may have changed or be unavailable. Retry after refreshing; `
      + `DocFlow never force-pushes ${STATE_BRANCH}. ${error.message}`,
    );
  }
  git(repoRoot, ['update-ref', REMOTE_STATE_REF, commit], exec);
  return { pushed: true, remoteCommit: commit };
}

export function readStateFile(repoRoot, relativePath, exec = execFileSync) {
  const ref = stateReadRef(repoRoot, exec);
  if (!ref) return null;
  const out = git(repoRoot, ['show', `${ref}:${relativePath}`], exec, { allowFailure: true });
  return out === '' ? null : out;
}

export function stateFileRevision(repoRoot, relativePath, exec = execFileSync) {
  const ref = stateReadRef(repoRoot, exec);
  if (!ref) return null;
  return revParse(repoRoot, `${ref}:${relativePath}`, exec);
}

export function listStateFiles(repoRoot, prefix, exec = execFileSync) {
  const ref = stateReadRef(repoRoot, exec);
  if (!ref) return [];
  const out = git(repoRoot, ['ls-tree', '-r', '--name-only', ref, '--', prefix], exec, { allowFailure: true });
  return out.split('\n').map((line) => line.trim()).filter(Boolean);
}

export function runtimePath(repoRoot, exec = execFileSync) {
  const raw = git(repoRoot, ['rev-parse', '--git-path', 'docflow/runtime.json'], exec).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

function commonGitDir(repoRoot, exec = execFileSync) {
  const raw = git(repoRoot, ['rev-parse', '--git-common-dir'], exec).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

function sleepSync(milliseconds) {
  const buffer = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buffer), 0, 0, milliseconds);
}

function stateLockPath(repoRoot, homeDir, exec = execFileSync) {
  const key = createHash('sha256').update(commonGitDir(repoRoot, exec)).digest('hex');
  return path.join(homeDir, '.docflow', 'locks', `state-${key}.lock`);
}

function withStateLock(repoRoot, homeDir, exec, fn, { timeoutMs = 5000, staleMs = 30000 } = {}) {
  const lockPath = stateLockPath(repoRoot, homeDir, exec);
  fs.mkdirSync(path.dirname(lockPath), { recursive: true, mode: 0o700 });
  const startedAt = Date.now();
  let descriptor = null;

  while (descriptor == null) {
    try {
      descriptor = fs.openSync(lockPath, 'wx', 0o600);
      fs.writeFileSync(descriptor, `${process.pid}\n`);
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.unlinkSync(lockPath);
          continue;
        }
      } catch (statError) {
        if (statError?.code === 'ENOENT') continue;
        throw statError;
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error('Timed out waiting for DocFlow durable-state lock');
      }
      sleepSync(25);
    }
  }

  try {
    return fn();
  } finally {
    try { fs.closeSync(descriptor); } catch { /* best effort */ }
    try { fs.unlinkSync(lockPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function identityEnv(repoRoot, exec = execFileSync) {
  const name = git(repoRoot, ['config', 'user.name'], exec, { allowFailure: true }).trim() || 'DocFlow';
  const email = git(repoRoot, ['config', 'user.email'], exec, { allowFailure: true }).trim() || 'docflow@local';
  return {
    GIT_AUTHOR_NAME: name,
    GIT_AUTHOR_EMAIL: email,
    GIT_COMMITTER_NAME: name,
    GIT_COMMITTER_EMAIL: email,
  };
}

export function commitStateFiles({
  repoRoot,
  files,
  expectedFiles = null,
  message,
  homeDir = os.homedir(),
  exec = execFileSync,
  allowCreate = true,
} = {}) {
  if (!repoRoot) throw new Error('repoRoot is required');
  if (!files || typeof files !== 'object' || Array.isArray(files)) throw new Error('files map is required');
  if (expectedFiles != null && (typeof expectedFiles !== 'object' || Array.isArray(expectedFiles))) {
    throw new Error('expectedFiles map must be an object');
  }

  return withStateLock(repoRoot, homeDir, exec, () => {
    const synchronized = synchronizeStateParent(repoRoot, exec);
    const parent = synchronized.parent ?? ensureLocalStateRef(repoRoot, exec);
    if (!parent && !allowCreate) throw new Error(`DocFlow durable state branch does not exist: ${STATE_BRANCH}`);

    if (expectedFiles) {
      for (const [relativePath, expectedRevision] of Object.entries(expectedFiles)) {
        if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.startsWith('../')) {
          throw new Error(`Invalid DocFlow state path: ${relativePath}`);
        }
        const actualRevision = parent ? revParse(repoRoot, `${parent}:${relativePath}`, exec) : null;
        const expected = expectedRevision == null ? null : String(expectedRevision).trim();
        if (actualRevision !== expected) {
          throw new Error(
            `DocFlow durable state changed concurrently for ${relativePath}; reload state and retry`,
          );
        }
      }
    }

    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-index-'));
    const indexPath = path.join(tempDir, 'index');
    const env = { GIT_INDEX_FILE: indexPath, ...identityEnv(repoRoot, exec) };

    try {
      if (parent) git(repoRoot, ['read-tree', parent], exec, { env });
      else git(repoRoot, ['read-tree', '--empty'], exec, { env });

      for (const [relativePath, value] of Object.entries(files)) {
        if (!relativePath || path.posix.isAbsolute(relativePath) || relativePath.startsWith('../')) {
          throw new Error(`Invalid DocFlow state path: ${relativePath}`);
        }
        if (value == null) {
          git(repoRoot, ['update-index', '--force-remove', '--', relativePath], exec, { env, allowFailure: true });
          continue;
        }
        const blob = git(repoRoot, ['hash-object', '-w', '--stdin'], exec, {
          env,
          input: String(value),
        }).trim();
        git(repoRoot, ['update-index', '--add', '--cacheinfo', `100644,${blob},${relativePath}`], exec, { env });
      }

      const tree = git(repoRoot, ['write-tree'], exec, { env }).trim();
      if (parent) {
        const oldTree = git(repoRoot, ['rev-parse', `${parent}^{tree}`], exec).trim();
        if (oldTree === tree) {
          const pushed = synchronized.remoteConfigured
            ? pushStateCommit(repoRoot, parent, exec)
            : { pushed: false, remoteCommit: null };
          return {
            branch: STATE_BRANCH,
            commit: parent,
            changed: false,
            pushed: pushed.pushed,
            remoteCommit: pushed.remoteCommit,
          };
        }
      }

      const args = ['commit-tree', tree, '-m', message || 'Update DocFlow state'];
      if (parent) args.push('-p', parent);
      const commit = git(repoRoot, args, exec, { env }).trim();

      const pushed = synchronized.remoteConfigured
        ? pushStateCommit(repoRoot, commit, exec)
        : { pushed: false, remoteCommit: null };

      if (parent) git(repoRoot, ['update-ref', STATE_REF, commit, parent], exec);
      else git(repoRoot, ['update-ref', STATE_REF, commit], exec);
      return {
        branch: STATE_BRANCH,
        commit,
        changed: true,
        pushed: pushed.pushed,
        remoteCommit: pushed.remoteCommit,
      };
    } finally {
      fs.rmSync(tempDir, { recursive: true, force: true });
    }
  });
}

export function stateUnitPath(taskId) {
  const id = String(taskId ?? '').trim();
  if (!id) throw new Error('task id is required');
  return `.docflow/units/${encodeURIComponent(id)}.json`;
}
