import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { syncAgentStatus, listRegisteredRepos } from './catchup.js';
import { gateStatus, loadGlobalConfig, loadRepoConfig, loadState, resolveRepoRoot } from './core.js';
import { globalStatus } from './install.js';
import { workflowStatus } from './github.js';
import { commitHookStatus } from './hooks.js';
import { readActivation } from './ingest.js';
import { stateStoreStatus } from './state-store.js';

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
      const store = stateStoreStatus(repoRoot);
      checks.push({ name: 'durable_state', ok: Boolean(store.readRef), detail: store.readRef ? `${store.branch} (${store.remoteCommit ? 'published to origin' : 'local only'})` : `${store.branch} branch missing` });
      let activation = null;
      try { activation = readActivation(repoRoot); } catch (error) { checks.push({ name: 'commit_native', ok: false, detail: error.message }); }
      const required = Boolean(activation); // once activated, missing integration is a failure
      const report = (name, status, fixHint) => checks.push({
        name, ok: status.state === 'current' || !required, info: status.state !== 'current' && !required,
        detail: status.state === 'current' ? `current (${status.path})` : `${status.state} (${status.path}); ${fixHint}`,
      });
      report('commit_hook', commitHookStatus({ cwd: repoRoot }), 'run `docflow setup-repo`');
      report('github_workflow', workflowStatus({ cwd: repoRoot }), 'run `docflow setup-repo`, then commit and push the workflow');
      checks.push({
        name: 'commit_native', ok: true, info: true,
        detail: activation ? `active since ${activation.activatedAt}` : 'not activated; run `docflow setup-repo` to enable commit-native progress',
      });
      const gate = gateStatus({ cwd: repoRoot });
      checks.push({ name: 'repo_gate', ok: true, info: true, detail: `${gate.status}: ${gate.reason} (legacy checkpoint gate; not required for commit-native repositories)` });
    }
  }
  const obsidian = loadGlobalConfig(homeDir);
  checks.push({ name: 'obsidian_config', ok: true, info: true, detail: obsidian ? `${obsidian.obsidian.vault}/${obsidian.obsidian.projectFolder}` : 'not configured' });
  const agent = syncAgentStatus({ homeDir, cliPath: CLI });
  checks.push({
    name: 'sync_agent', ok: true, info: agent.state !== 'current',
    detail: agent.state === 'current'
      ? `current (${agent.path})`
      : `${agent.state} (${agent.path}); run \`docflow install-sync-agent\` for automatic Obsidian catch-up (manual \`docflow sync\` always works)`,
  });
  let registered = 0;
  try { registered = listRegisteredRepos(homeDir).length; } catch { /* reported by catch-up */ }
  checks.push({ name: 'sync_registry', ok: true, info: true, detail: `${registered} repositor${registered === 1 ? 'y' : 'ies'} registered for catch-up` });
  return { ok: checks.every((c) => c.ok), checks };
}

export function formatDoctor(result) {
  const lines = result.checks.map((check) => `${check.ok ? (check.info ? 'info' : 'ok') : 'FAIL'}  ${check.name}: ${check.detail}`);
  lines.push(result.ok ? 'doctor: all core prerequisites satisfied' : 'doctor: one or more required checks failed');
  return lines.join('\n');
}
