// Keep this DocFlow checkout on the latest *released* version. A release is the stable `v2`
// tag, which only moves when the owner runs the "Release stable tag" workflow (tests first).
// Conservative by design: fast-forward only, never touches local changes, never runs
// anything it just downloaded in the same process, and is silent when offline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal } from './install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const STABLE_TAG = 'v2';

export function autoUpdateOptOutPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.docflow', 'auto-update-off');
}

function git(appDir, args, exec) {
  return String(exec('git', ['-C', appDir, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  }) ?? '').trim();
}

export function selfUpdate({
  appDir = ROOT, homeDir = os.homedir(), exec = execFileSync, tag = STABLE_TAG,
  reinstallPolicy = () => installGlobal({ homeDir }),
} = {}) {
  if (fs.existsSync(autoUpdateOptOutPath(homeDir))) return { updated: false, reason: 'auto-update is turned off' };
  if (!fs.existsSync(path.join(appDir, '.git'))) return { updated: false, reason: 'not a git checkout' };
  try {
    if (git(appDir, ['status', '--porcelain'], exec)) return { updated: false, reason: 'local changes in the DocFlow folder' };
    if (git(appDir, ['branch', '--show-current'], exec) !== 'main') return { updated: false, reason: 'DocFlow folder is not on main' };
    try {
      git(appDir, ['fetch', '--quiet', '--force', 'origin', `refs/tags/${tag}:refs/tags/${tag}`], exec);
    } catch {
      return { updated: false, reason: 'offline or no release tag yet' };
    }
    const head = git(appDir, ['rev-parse', 'HEAD'], exec);
    const released = git(appDir, ['rev-parse', `refs/tags/${tag}^{commit}`], exec);
    if (head === released) return { updated: false, reason: 'already on the latest release', version: released.slice(0, 7) };
    try {
      git(appDir, ['merge-base', '--is-ancestor', head, released], exec);
    } catch {
      return { updated: false, reason: 'this folder is ahead of or diverged from the release; not changing it' };
    }
    git(appDir, ['merge', '--ff-only', `refs/tags/${tag}`], exec);
    let policy = 'reinstalled';
    try { reinstallPolicy(); } catch (error) { policy = `not reinstalled: ${String(error?.message ?? error).split('\n')[0]}`; }
    return { updated: true, from: head.slice(0, 7), to: released.slice(0, 7), policy };
  } catch (error) {
    return { updated: false, reason: `update check failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
}
