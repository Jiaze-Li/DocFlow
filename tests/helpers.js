import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { commitStateFiles, resolveStateUnitPath, stateFileRevision } from '../src/state-store.js';
import { loadState } from '../src/core.js';

export function tempGitRepo({ objectFormat = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-repo-'));
  const args = ['init'];
  if (objectFormat) args.push(`--object-format=${objectFormat}`);
  args.push('-q', root);
  execFileSync('git', args);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'DocFlow Test']);
  fs.writeFileSync(path.join(root, 'app.txt'), 'initial\n');
  execFileSync('git', ['-C', root, 'add', 'app.txt']);
  execFileSync('git', ['-C', root, 'commit', '-qm', 'initial']);
  return root;
}

export function tempHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-home-'));
}

export function tempBareGitRepo({ objectFormat = null } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-remote-'));
  const args = ['init', '--bare'];
  if (objectFormat) args.push(`--object-format=${objectFormat}`);
  args.push('-q', root);
  execFileSync('git', args);
  return root;
}

export function cloneGitRepo(remote) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-clone-parent-'));
  const root = path.join(parent, 'repo');
  execFileSync('git', ['clone', '-q', remote, root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.com']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'DocFlow Test']);
  return root;
}

// Writes a pre-commit-native ("legacy") unit straight to durable state, as old DocFlow versions
// did. Fails closed if the unit already exists. Used to prove old notes still read and render.
export function seedUnit(repoRoot, fields, { homeDir, exec, updatedAt = '2026-10-01T00:00:00.000Z' } = {}) {
  const task = {
    title: fields.id, task: 'Seeded unit', started: '2026-10-01T00:00:00.000Z', status: 'In progress',
    current: '', next: '', history: [], completed: null, outcome: null, ...fields,
  };
  const unitPath = resolveStateUnitPath(repoRoot, task.id);
  commitStateFiles({
    repoRoot, homeDir, ...(exec ? { exec } : {}),
    files: { [unitPath]: `${JSON.stringify({ schemaVersion: 1, updatedAt, task }, null, 2)}\n` },
    expectedFiles: { [unitPath]: null },
    message: `test: seed ${task.id}`,
    allowCreate: false,
  });
  return task;
}

// Applies a patch to an existing unit with the same compare-and-swap discipline the real writers use.
export function reviseUnit(repoRoot, id, patch, { homeDir, exec, updatedAt = '2026-10-02T00:00:00.000Z' } = {}) {
  const unitPath = resolveStateUnitPath(repoRoot, id);
  const expected = stateFileRevision(repoRoot, unitPath);
  const task = { ...loadState(repoRoot).tasks.find((t) => t.id === id), ...patch };
  commitStateFiles({
    repoRoot, homeDir, ...(exec ? { exec } : {}),
    files: { [unitPath]: `${JSON.stringify({ schemaVersion: 1, updatedAt, task }, null, 2)}\n` },
    expectedFiles: { [unitPath]: expected },
    message: `test: revise ${id}`,
    allowCreate: false,
  });
  return task;
}

// Option-bag forms for tests that inject a racing `exec` to interleave a second writer.
export function startUnit({ cwd, homeDir, exec, ...fields }) {
  return seedUnit(cwd, fields, { homeDir, exec });
}

export function reviseUnitAt({ cwd, homeDir, exec, id, ...patch }) {
  return reviseUnit(cwd, id, patch, { homeDir, exec });
}
