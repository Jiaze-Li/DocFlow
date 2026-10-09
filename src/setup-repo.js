// One-shot enablement of commit-native progress for a DocFlow-enabled repository.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { loadRepoConfig, resolveRepoRoot } from './core.js';
import { installWorkflow } from './github.js';
import { installCommitHook } from './hooks.js';
import { activateCommitNative } from './ingest.js';

export function setupRepo({
  cwd = process.cwd(), homeDir = os.homedir(), exec = execFileSync, actionRef, activate = true,
} = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  if (!loadRepoConfig(repoRoot, exec)) throw new Error('DocFlow is not enabled in this repository; run `docflow init` first');
  const hook = installCommitHook({ cwd: repoRoot, exec });
  const workflow = installWorkflow({ cwd: repoRoot, exec, ...(actionRef ? { actionRef } : {}) });
  const activation = activate ? activateCommitNative({ cwd: repoRoot, homeDir, exec }) : null;
  return {
    repoRoot, hook, workflow,
    activation: activation ? { created: activation.created, activatedAt: activation.activation.activatedAt, branchesAtActivation: activation.activation.branches.length } : null,
    next: workflow.changed ? 'Commit and push the new workflow file so GitHub starts ingesting pushes.' : 'Workflow already in place.',
  };
}
