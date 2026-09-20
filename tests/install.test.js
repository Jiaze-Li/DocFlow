import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { globalStatus, installGlobal, POLICY_BEGIN, POLICY_END } from '../src/install.js';
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
    assert.match(text, /History is factual and append-only/);
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
