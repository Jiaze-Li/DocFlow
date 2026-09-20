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
