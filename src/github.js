// Per-repository GitHub Actions wiring. The workflow is a thin caller; the ingestion
// logic is owned by the DocFlow action (action/action.yml) and src/ingest.js.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveRepoRoot } from './core.js';

export const WORKFLOW_MARKER = '# DOCFLOW-WORKFLOW v1';
export const WORKFLOW_FILE = '.github/workflows/docflow.yml';
export const DEFAULT_ACTION_REPO = 'Jiaze-Li/DocFlow';
export const DEFAULT_ACTION_REF = 'main';

export function renderWorkflow({ actionRepo = DEFAULT_ACTION_REPO, actionRef = DEFAULT_ACTION_REF } = {}) {
  return `${WORKFLOW_MARKER} (thin caller managed by DocFlow; logic lives in ${actionRepo}/action)
name: DocFlow progress

on:
  push:
    branches-ignore: [main, master, docflow-state]
  pull_request:
    types: [opened, reopened, synchronize, closed]

# docflow-state is the only ref this job writes. GITHUB_TOKEN pushes never trigger workflows
# and docflow-state is ignored above, so state updates cannot recurse into business progress.
# No concurrency group on purpose: GitHub cancels queued runs in a group, and a cancelled run
# would drop its event. Concurrent runs are safe (fast-forward-only state push + retry).
permissions:
  contents: write

jobs:
  ingest:
    if: github.event_name == 'push' || github.event.pull_request.head.repo.full_name == github.repository
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
        with:
          fetch-depth: 0
      - uses: ${actionRepo}/action@${actionRef}
`;
}

export function workflowPath(repoRoot) {
  return path.join(repoRoot, WORKFLOW_FILE);
}

/** @returns {{ state: 'missing'|'current'|'stale'|'foreign', path: string }} */
export function workflowStatus({ cwd = process.cwd(), exec = execFileSync, ...options } = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  const file = workflowPath(repoRoot);
  if (!fs.existsSync(file)) return { state: 'missing', path: file };
  const text = fs.readFileSync(file, 'utf8');
  if (!text.startsWith(WORKFLOW_MARKER)) return { state: 'foreign', path: file };
  // Only the pinned ref may differ from the template without the workflow being stale.
  const normalize = (value) => value.replace(/(\/action@)\S+/, '$1<ref>');
  return { state: normalize(text) === normalize(renderWorkflow(options)) ? 'current' : 'stale', path: file };
}

export function installWorkflow({ cwd = process.cwd(), exec = execFileSync, ...options } = {}) {
  const status = workflowStatus({ cwd, exec, ...options });
  if (status.state === 'foreign') {
    throw new Error(`${status.path} exists and is not managed by DocFlow; merge the DocFlow job into it manually (see README).`);
  }
  if (status.state === 'missing' || status.state === 'stale') {
    fs.mkdirSync(path.dirname(status.path), { recursive: true });
    fs.writeFileSync(status.path, renderWorkflow(options));
  }
  return { path: status.path, changed: status.state !== 'current' };
}

export function formatIngestSummary(result) {
  const lines = ['### DocFlow progress ingestion', ''];
  if (result.skipped) {
    lines.push(`Skipped: ${result.reason}`);
    return lines.join('\n');
  }
  lines.push(`- Branch: \`${result.branch}\``);
  if (result.mode) lines.push(`- Selection: ${result.mode} (${result.candidates} candidate commit${result.candidates === 1 ? '' : 's'})`);
  lines.push(`- Recorded: ${result.recorded.length}`, `- Already recorded: ${result.alreadyRecorded.length}`);
  if (result.prNumber) lines.push(`- Pull request: #${result.prNumber}${result.merged ? ' (merged)' : ''}`);
  if (result.ignored) lines.push(`- Ignored: ${result.reason}`);
  if (result.warnings.length) {
    lines.push('', '**Commit message warnings** (commits were still ingested; history is never rewritten):');
    for (const w of result.warnings) {
      lines.push(`- \`${w.sha.slice(0, 7)}\` ${JSON.stringify(w.subject)} — ${w.problems.map((p) => p.reason).join(' ')}`);
    }
  }
  return lines.join('\n');
}
