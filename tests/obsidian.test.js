import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  checkpoint,
  configureGlobal,
  initRepo,
  startTask,
  syncObsidian,
  upsertManagedBlock,
} from '../src/core.js';
import { tempGitRepo, tempHome } from './helpers.js';

test('Obsidian sync preserves manual project content and updates only one managed block', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  const projects = path.join(vault, '02 Projects');
  fs.mkdirSync(projects, { recursive: true });
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  const note = path.join(projects, 'project - spinlab.md');
  fs.writeFileSync(note, '---\ntype: project\n---\n\n## Project definition\nManual content stays here.\n');

  startTask({ cwd: repo, id: '5.3.8', title: 'AFM plotting', task: 'Add AFM plotting.', current: 'First version plots data.', next: 'Adjust UI.' });
  syncObsidian({ cwd: repo, homeDir: home });
  checkpoint({ cwd: repo, current: 'UI first revision is complete.', next: 'Add flatten.' });
  syncObsidian({ cwd: repo, homeDir: home });

  const text = fs.readFileSync(note, 'utf8');
  assert.match(text, /Manual content stays here/);
  assert.equal(text.split(MANAGED_BEGIN).length - 1, 1);
  assert.equal(text.split(MANAGED_END).length - 1, 1);
  assert.match(text, /## 5\.3\.8 · AFM plotting/);
  assert.match(text, /UI first revision is complete/);
  assert.match(text, /- First version plots data\./);
});

test('missing Obsidian note is created as standard Markdown', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, projectName: 'ReviewLoop', summary: 'Independent review workflow.', obsidianNote: 'project - reviewloop.md' });
  startTask({ cwd: repo, id: '2.1.0', title: 'DocFlow integration', task: 'Integrate progress memory.' });
  const result = syncObsidian({ cwd: repo, homeDir: home });
  assert.equal(result.created, true);
  const text = fs.readFileSync(result.path, 'utf8');
  assert.match(text, /type: project/);
  assert.match(text, /# ReviewLoop/);
  assert.match(text, /Independent review workflow/);
  assert.match(text, /DOCFLOW:START/);
});

test('malformed managed markers fail closed', () => {
  assert.throws(() => upsertManagedBlock(`manual\n${MANAGED_BEGIN}\nbroken`, `${MANAGED_BEGIN}\nok\n${MANAGED_END}\n`), /malformed/);
});
