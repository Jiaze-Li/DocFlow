import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gateStatus, loadGlobalConfig, loadRepoConfig, loadState, resolveRepoRoot } from './core.js';
import { globalStatus } from './install.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'docflow.js');

function commandVersion(command) {
  try { return String(execFileSync(command, ['--version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })).trim(); }
  catch { return null; }
}

export function doctor({ cwd = process.cwd(), homeDir = os.homedir() } = {}) {
  const checks = [];
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  checks.push({ name: 'node', ok: nodeMajor >= 20, detail: process.version });
  const git = commandVersion('git');
  checks.push({ name: 'git', ok: Boolean(git), detail: git || 'missing' });
  const global = globalStatus({ homeDir, cliPath: CLI });
  for (const name of ['claude', 'codex', 'agy']) {
    if (!global[name].available) checks.push({ name: `global_${name}`, ok: true, info: true, detail: 'agent not installed; skipped' });
    else checks.push({ name: `global_${name}`, ok: global[name].installed, detail: global[name].installed ? 'policy installed' : 'policy missing/stale' });
  }
  let repoRoot = null;
  try { repoRoot = resolveRepoRoot(cwd); } catch { /* no repo is allowed for global doctor */ }
  if (repoRoot) {
    const repoConfig = loadRepoConfig(repoRoot);
    if (!repoConfig) checks.push({ name: 'repo', ok: true, info: true, detail: 'current repo has not enabled DocFlow' });
    else {
      try { loadState(repoRoot); checks.push({ name: 'repo_state', ok: true, detail: repoConfig.projectName }); }
      catch (error) { checks.push({ name: 'repo_state', ok: false, detail: error.message }); }
      const gate = gateStatus({ cwd: repoRoot });
      checks.push({ name: 'repo_gate', ok: true, info: true, detail: `${gate.status}: ${gate.reason}` });
    }
  }
  const obsidian = loadGlobalConfig(homeDir);
  checks.push({ name: 'obsidian_config', ok: true, info: true, detail: obsidian ? `${obsidian.obsidian.vault}/${obsidian.obsidian.projectFolder}` : 'not configured' });
  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctor(result) {
  const lines = result.checks.map((check) => `${check.ok ? (check.info ? 'info' : 'ok') : 'FAIL'}  ${check.name}: ${check.detail}`);
  lines.push(result.ok ? 'doctor: all core prerequisites satisfied' : 'doctor: one or more required checks failed');
  return lines.join('\n');
}
