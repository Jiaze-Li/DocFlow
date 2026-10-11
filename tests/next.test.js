import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { configureGlobal, initRepo, loadState, recordCommitProgress, setBranchNext } from '../src/core.js';
import { tempGitRepo, tempHome } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'docflow.js');
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();

function setup() {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = fs.mkdtempSync(path.join(home, 'vault-'));
  configureGlobal({ homeDir: home, vault, projectFolder: 'Projects' });
  initRepo({ cwd: repo, homeDir: home, projectName: 'Proj', obsidianNote: 'project - proj.md' });
  git(repo, 'checkout', '-qb', 'feat/ui');
  const record = (message, day) => {
    git(repo, 'commit', '--allow-empty', '-q', '--no-verify', '-m', message);
    const sha = git(repo, 'rev-parse', 'HEAD');
    recordCommitProgress({ cwd: repo, homeDir: home, branch: 'feat/ui', commit: { sha, message, timestamp: `2026-10-0${day}T00:00:00.000Z` } });
  };
  return { repo, home, vault, record, note: path.join(vault, 'Projects', 'project - proj.md') };
}

test('next is stored on the branch unit and survives later commits', () => {
  const { repo, home, record } = setup();
  record('Add the settings page', 1);
  const first = setBranchNext({ cwd: repo, homeDir: home, branch: 'feat/ui', next: 'Wire up dark mode' });
  assert.equal(first.changed, true);
  assert.equal(setBranchNext({ cwd: repo, homeDir: home, branch: 'feat/ui', next: 'Wire up dark mode' }).changed, false);
  record('Add the profile page', 2);
  assert.equal(loadState(repo).tasks[0].next, 'Wire up dark mode');
  setBranchNext({ cwd: repo, homeDir: home, branch: 'feat/ui', next: '' });
  assert.equal(loadState(repo).tasks[0].next, '');
});

test('next refuses a branch that has no recorded progress yet', () => {
  const { repo, home } = setup();
  assert.throws(() => setBranchNext({ cwd: repo, homeDir: home, branch: 'feat/ui', next: 'x' }), /No DocFlow progress recorded yet/);
});

test('docflow next projects into the Obsidian note and --clear removes it', () => {
  const { repo, home, record, note } = setup();
  record('Add the settings page', 1);
  const run = (...args) => execFileSync('node', [CLI, ...args, '--cwd', repo], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  run('next', 'Wire', 'up', 'dark', 'mode');
  assert.match(fs.readFileSync(note, 'utf8'), /### Next\nWire up dark mode/);
  run('next', '--clear');
  assert.doesNotMatch(fs.readFileSync(note, 'utf8'), /### Next/);
});

test('docflow next keeps text that starts with -- when given after a bare --', () => {
  const { repo, home, record, note } = setup();
  record('Add the settings page', 1);
  execFileSync('node', [CLI, 'next', '--cwd', repo, '--', '--experimental flag support'], { encoding: 'utf8', env: { ...process.env, HOME: home } });
  assert.match(fs.readFileSync(note, 'utf8'), /### Next\n--experimental flag support/);
  assert.equal(loadState(repo).tasks[0].next, '--experimental flag support');
});
