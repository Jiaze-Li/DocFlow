import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { globalStatus, installGlobal, POLICY_BEGIN, POLICY_END } from '../src/install.js';
import { atomicWrite } from '../src/core.js';
import { tempHome } from './helpers.js';

test('global install writes one shared policy for Claude, Codex and AGY and is idempotent', () => {
  const home = tempHome();
  const cliPath = '/opt/docflow/bin/docflow.js';
  const present = { claude: true, codex: true, agy: true };
  installGlobal({ homeDir: home, cliPath, present, configDir: path.join(home, '.gemini', 'config') });
  installGlobal({ homeDir: home, cliPath, present, configDir: path.join(home, '.gemini', 'config') });

  const status = globalStatus({ homeDir: home, cliPath, present, configDir: path.join(home, '.gemini', 'config') });
  assert.equal(status.claude.installed, true);
  assert.equal(status.codex.installed, true);
  assert.equal(status.agy.installed, true);
  assert.equal(status.agy.skillInstalled, true);

  for (const file of [status.claude.file, status.codex.file, status.agy.file]) {
    const text = fs.readFileSync(file, 'utf8');
    assert.equal(text.split(POLICY_BEGIN).length - 1, 1);
    assert.equal(text.split(POLICY_END).length - 1, 1);
    assert.match(text, /docflow.js" next /);
    assert.match(text, /\/opt\/docflow\/bin\/docflow\.js/);
  }
});

test('global install skips absent agents instead of failing', () => {
  const home = tempHome();
  const present = { claude: false, codex: true, agy: false };
  installGlobal({ homeDir: home, cliPath: '/tmp/docflow.js', present });
  const status = globalStatus({ homeDir: home, cliPath: '/tmp/docflow.js', present });
  assert.equal(status.codex.installed, true);
  assert.equal(status.claude.installed, false);
  assert.equal(status.agy.installed, false);
});

test('global install keeps a symlinked rules file a symlink and updates its target', () => {
  const home = tempHome();
  const dotfiles = path.join(home, 'dotfiles');
  fs.mkdirSync(dotfiles, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  const real = path.join(dotfiles, 'CLAUDE.md');
  fs.writeFileSync(real, '# My rules\n');
  const link = path.join(home, '.claude', 'CLAUDE.md');
  fs.symlinkSync(path.join('..', 'dotfiles', 'CLAUDE.md'), link);

  const present = { claude: true, codex: false, agy: false };
  installGlobal({ homeDir: home, cliPath: '/tmp/docflow.js', present });
  installGlobal({ homeDir: home, cliPath: '/tmp/docflow.js', present });

  assert.equal(fs.lstatSync(link).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(link), path.join('..', 'dotfiles', 'CLAUDE.md'));
  assert.equal(fs.lstatSync(real).isSymbolicLink(), false);
  const text = fs.readFileSync(real, 'utf8');
  assert.match(text, /# My rules/);
  assert.equal(text.split(POLICY_BEGIN).length - 1, 1);
  assert.equal(globalStatus({ homeDir: home, cliPath: '/tmp/docflow.js', present }).claude.installed, true);
  assert.deepEqual(fs.readdirSync(path.join(home, '.claude')), ['CLAUDE.md']);
  assert.deepEqual(fs.readdirSync(dotfiles), ['CLAUDE.md']);
});

test('atomicWrite follows link chains and dangling links, and leaves plain files plain', () => {
  const home = tempHome();
  const real = path.join(home, 'store', 'real.md');
  fs.mkdirSync(path.join(home, 'links'), { recursive: true });
  fs.symlinkSync(real, path.join(home, 'links', 'inner.md'));
  fs.symlinkSync('inner.md', path.join(home, 'links', 'outer.md'));

  atomicWrite(path.join(home, 'links', 'outer.md'), 'through a dangling chain\n');
  assert.equal(fs.lstatSync(path.join(home, 'links', 'outer.md')).isSymbolicLink(), true);
  assert.equal(fs.lstatSync(path.join(home, 'links', 'inner.md')).isSymbolicLink(), true);
  assert.equal(fs.readFileSync(real, 'utf8'), 'through a dangling chain\n');
  assert.equal(fs.statSync(real).mode & 0o777, 0o600);

  const plain = path.join(home, 'new', 'plain.md');
  atomicWrite(plain, 'one\n');
  atomicWrite(plain, 'two\n');
  assert.equal(fs.lstatSync(plain).isSymbolicLink(), false);
  assert.equal(fs.readFileSync(plain, 'utf8'), 'two\n');
  assert.equal(fs.statSync(plain).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(plain)), ['plain.md']);

  fs.symlinkSync('loop-b', path.join(home, 'loop-a'));
  fs.symlinkSync('loop-a', path.join(home, 'loop-b'));
  assert.throws(() => atomicWrite(path.join(home, 'loop-a'), 'x'), /Too many levels of symbolic links/);
});
