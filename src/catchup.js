// Zero-model local catch-up: observe the newest durable DocFlow state and refresh the
// Obsidian projection. A registry of known repositories lets one lightweight, periodic
// one-shot process (launchd, no resident daemon) cover every DocFlow repo on this Mac,
// including after the Mac was offline or asleep.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { atomicWrite, loadRepoConfig, resolveRepoRoot, syncObsidian } from './core.js';
import { refreshStateFromOrigin } from './state-store.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLI = path.join(ROOT, 'bin', 'docflow.js');
export const AGENT_LABEL = 'com.docflow.catchup';
export const DEFAULT_INTERVAL_SECONDS = 600;

export function registryPath(homeDir = os.homedir()) {
  return path.join(homeDir, '.docflow', 'repos.json');
}

export function listRegisteredRepos(homeDir = os.homedir()) {
  const file = registryPath(homeDir);
  if (!fs.existsSync(file)) return [];
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.repos)) throw new Error(`Unsupported DocFlow repo registry: ${file}`);
  return value.repos.filter((r) => typeof r?.root === 'string' && path.isAbsolute(r.root));
}

/** Idempotent; keeps the registry a plain, bounded, sorted list of absolute repo roots. */
export function registerRepo({ repoRoot, homeDir = os.homedir() }) {
  const root = path.resolve(repoRoot);
  const repos = listRegisteredRepos(homeDir);
  if (repos.some((r) => r.root === root)) return { registered: false, root };
  repos.push({ root, registeredAt: new Date().toISOString() });
  repos.sort((a, b) => a.root.localeCompare(b.root));
  if (repos.length > 500) throw new Error('DocFlow repo registry is full (500)');
  atomicWrite(registryPath(homeDir), `${JSON.stringify({ schemaVersion: 1, repos }, null, 2)}\n`);
  return { registered: true, root };
}

/**
 * Refresh one repository: fetch the latest docflow-state (best effort; offline or a
 * diverged remote falls back to the newest state already present locally) and project it.
 * Never throws for one repository's problem.
 */
export function catchUpRepo({ repoRoot, homeDir = os.homedir(), exec = execFileSync }) {
  const result = { repoRoot, refreshed: false, offline: false, synced: false };
  try {
    if (!fs.existsSync(repoRoot)) return { ...result, error: 'repository path no longer exists' };
    const root = resolveRepoRoot(repoRoot, exec);
    // Refresh first: a clone that has never fetched docflow-state cannot even see its
    // DocFlow config until the durable state arrives.
    try {
      refreshStateFromOrigin({ repoRoot: root, homeDir, exec });
      result.refreshed = true;
    } catch (error) {
      result.offline = true;
      result.refreshError = String(error?.message ?? error).split('\n')[0].slice(0, 300);
    }
    if (!loadRepoConfig(root, exec)) return { ...result, skipped: true, reason: 'DocFlow is not enabled in this repository' };
    const sync = syncObsidian({ cwd: root, homeDir, exec });
    return { ...result, synced: !sync.skipped, ...(sync.skipped ? { skipped: true, reason: sync.reason } : { path: sync.path, updatedTaskIds: sync.updatedTaskIds }) };
  } catch (error) {
    return { ...result, error: String(error?.message ?? error).split('\n')[0].slice(0, 300) };
  }
}

export function catchUpAll({ homeDir = os.homedir(), exec = execFileSync } = {}) {
  const repos = listRegisteredRepos(homeDir);
  const results = repos.map((r) => catchUpRepo({ repoRoot: r.root, homeDir, exec }));
  return { repos: results, ok: results.every((r) => !r.error) };
}

export function agentPlistPath(homeDir = os.homedir()) {
  return path.join(homeDir, 'Library', 'LaunchAgents', `${AGENT_LABEL}.plist`);
}

function xml(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Prefer a version-independent Homebrew entrypoint, but only when it resolves to
// the exact Node executable running DocFlow. Other Node installations keep their
// existing behavior; a different Homebrew Node is never substituted silently.
export function stableNodePath(executable = process.execPath, candidates = ['/opt/homebrew/bin/node', '/usr/local/bin/node']) {
  let resolved;
  try { resolved = fs.realpathSync(executable); } catch { return executable; }
  for (const candidate of candidates) {
    try {
      if (fs.realpathSync(candidate) !== resolved) continue;
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch { /* Missing, inaccessible or different Node: try next candidate. */ }
  }
  return executable;
}

export function renderAgentPlist({ homeDir = os.homedir(), cliPath = DEFAULT_CLI, nodePath = stableNodePath(), intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}) {
  const logDir = path.join(homeDir, '.docflow', 'logs');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${AGENT_LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(nodePath)}</string>
    <string>${xml(path.resolve(cliPath))}</string>
    <string>catch-up</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict><key>HOME</key><string>${xml(homeDir)}</string></dict>
  <key>RunAtLoad</key><true/>
  <key>StartInterval</key><integer>${Number(intervalSeconds)}</integer>
  <key>StandardOutPath</key><string>${xml(path.join(logDir, 'catchup.log'))}</string>
  <key>StandardErrorPath</key><string>${xml(path.join(logDir, 'catchup.err.log'))}</string>
</dict>
</plist>
`;
}

/** Writes the LaunchAgent definition only. Loading it is a separate, explicit step. */
export function installSyncAgent({ homeDir = os.homedir(), cliPath = DEFAULT_CLI, nodePath = stableNodePath(), intervalSeconds = DEFAULT_INTERVAL_SECONDS } = {}) {
  const interval = Math.floor(Number(intervalSeconds));
  if (!Number.isFinite(interval) || interval < 60 || interval > 86400) throw new Error('interval must be between 60 and 86400 seconds');
  const file = agentPlistPath(homeDir);
  fs.mkdirSync(path.join(homeDir, '.docflow', 'logs'), { recursive: true });
  atomicWrite(file, renderAgentPlist({ homeDir, cliPath, nodePath, intervalSeconds: interval }));
  return { plist: file, intervalSeconds: interval, loadCommand: `launchctl bootstrap gui/$(id -u) ${JSON.stringify(file)}` };
}

export function uninstallSyncAgent({ homeDir = os.homedir() } = {}) {
  const file = agentPlistPath(homeDir);
  const existed = fs.existsSync(file);
  if (existed) fs.unlinkSync(file);
  return { plist: file, removed: existed, unloadCommand: `launchctl bootout gui/$(id -u)/${AGENT_LABEL}` };
}

export function syncAgentStatus({ homeDir = os.homedir(), cliPath = DEFAULT_CLI, nodePath = stableNodePath() } = {}) {
  const file = agentPlistPath(homeDir);
  if (!fs.existsSync(file)) return { state: 'missing', path: file };
  const current = fs.readFileSync(file, 'utf8');
  const intervalMatch = /<key>StartInterval<\/key><integer>(\d+)<\/integer>/.exec(current);
  const expected = renderAgentPlist({ homeDir, cliPath, nodePath, intervalSeconds: Number(intervalMatch?.[1] ?? DEFAULT_INTERVAL_SECONDS) });
  return { state: current === expected ? 'current' : 'stale', path: file };
}
