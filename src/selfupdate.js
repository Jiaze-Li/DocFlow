// Keep this DocFlow checkout on the latest `main`. Every change reaches main through a pull
// request whose tests have passed, so main is the release.
// Conservative by design: fast-forward only, never touches local changes, never runs
// anything it just downloaded in the same process, and is silent when offline.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { installGlobal, installedPolicyTargets } from './install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

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
  appDir = ROOT, homeDir = os.homedir(), exec = execFileSync,
  // Refresh the policies that are already installed. Do not re-detect the agent CLIs: under
  // launchd the PATH is minimal and they would look absent.
  reinstallPolicy = () => {
    const present = installedPolicyTargets(homeDir);
    if (!Object.values(present).some(Boolean)) return;
    installGlobal({ homeDir, present });
  },
} = {}) {
  if (fs.existsSync(autoUpdateOptOutPath(homeDir))) return { updated: false, reason: 'auto-update is turned off' };
  if (!fs.existsSync(path.join(appDir, '.git'))) return { updated: false, reason: 'not a git checkout' };
  try {
    if (git(appDir, ['status', '--porcelain'], exec)) return { updated: false, reason: 'local changes in the DocFlow folder' };
    if (git(appDir, ['branch', '--show-current'], exec) !== 'main') return { updated: false, reason: 'DocFlow folder is not on main' };
    try {
      git(appDir, ['fetch', '--quiet', 'origin', '+refs/heads/main:refs/remotes/origin/main'], exec);
    } catch {
      return { updated: false, reason: 'offline or origin is unreachable' };
    }
    const head = git(appDir, ['rev-parse', 'HEAD'], exec);
    const released = git(appDir, ['rev-parse', 'refs/remotes/origin/main^{commit}'], exec);
    if (head === released) return { updated: false, reason: 'already on the latest version', version: released.slice(0, 7) };
    try {
      git(appDir, ['merge-base', '--is-ancestor', head, released], exec);
    } catch {
      return { updated: false, reason: 'this folder is ahead of or diverged from origin/main; not changing it' };
    }
    git(appDir, ['merge', '--ff-only', 'refs/remotes/origin/main'], exec);
    let policy = 'reinstalled';
    try { reinstallPolicy(); } catch (error) { policy = `not reinstalled: ${String(error?.message ?? error).split('\n')[0]}`; }
    return { updated: true, from: head.slice(0, 7), to: released.slice(0, 7), policy };
  } catch (error) {
    return { updated: false, reason: `update check failed: ${String(error?.message ?? error).split('\n')[0].slice(0, 200)}` };
  }
}
