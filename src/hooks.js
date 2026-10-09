// Local commit-msg hook management. The hook only calls the deterministic validator.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveRepoRoot } from './core.js';

export const HOOK_MARKER = '# DOCFLOW-COMMIT-MSG-HOOK v1';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_CLI = path.join(ROOT, 'bin', 'docflow.js');

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export function renderHook({ nodePath = process.execPath, cliPath = DEFAULT_CLI } = {}) {
  return `#!/bin/sh
${HOOK_MARKER} (managed by DocFlow; deterministic subject check, no model involved)
NODE=${shellQuote(nodePath)}
CLI=${shellQuote(path.resolve(cliPath))}
if [ ! -x "$NODE" ] || [ ! -f "$CLI" ]; then
  echo "DocFlow: commit-message validator not found ($CLI); skipping the check. Run 'docflow doctor' or 'docflow setup-repo' to repair." >&2
  exit 0
fi
exec "$NODE" "$CLI" validate-message --file "$1"
`;
}

export function commitHookPath(repoRoot, exec = execFileSync) {
  const raw = String(exec('git', ['-C', repoRoot, 'rev-parse', '--git-path', 'hooks/commit-msg'], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
  })).trim();
  return path.isAbsolute(raw) ? raw : path.resolve(repoRoot, raw);
}

/** @returns {{ state: 'missing'|'current'|'stale'|'foreign', path: string }} */
export function commitHookStatus({ cwd = process.cwd(), nodePath, cliPath, exec = execFileSync } = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  const file = commitHookPath(repoRoot, exec);
  if (!fs.existsSync(file)) return { state: 'missing', path: file };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.includes(HOOK_MARKER)) return { state: 'foreign', path: file };
  const executable = (fs.statSync(file).mode & 0o111) !== 0;
  return { state: text === renderHook({ nodePath, cliPath }) && executable ? 'current' : 'stale', path: file };
}

export function installCommitHook({ cwd = process.cwd(), nodePath, cliPath, exec = execFileSync } = {}) {
  const status = commitHookStatus({ cwd, nodePath, cliPath, exec });
  if (status.state === 'foreign') {
    throw new Error(
      `A different commit-msg hook already exists at ${status.path}; DocFlow will not overwrite it.\n`
      + `Add this line to that hook (before any 'exit') to enable DocFlow's subject check, then re-run setup:\n`
      + `  ${shellQuote(nodePath ?? process.execPath)} ${shellQuote(path.resolve(cliPath ?? DEFAULT_CLI))} validate-message --file "$1" || exit $?`,
    );
  }
  if (status.state !== 'current') {
    fs.mkdirSync(path.dirname(status.path), { recursive: true });
    fs.writeFileSync(status.path, renderHook({ nodePath, cliPath }), { mode: 0o755 });
    fs.chmodSync(status.path, 0o755);
  }
  return { path: status.path, state: 'current', changed: status.state !== 'current' };
}
