import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export function tempGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-repo-'));
  execFileSync('git', ['init', '-q', root]);
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

export function tempBareGitRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'docflow-remote-'));
  execFileSync('git', ['init', '--bare', '-q', root]);
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
