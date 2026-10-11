import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  configureGlobal,
  initRepo,
  loadState,
  syncObsidian,
  unitMarkers,
  upsertManagedBlock,
} from '../src/core.js';
import { reviseUnit, seedUnit, tempGitRepo, tempHome } from './helpers.js';

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

  seedUnit(repo, { id: '5.3.8', title: 'AFM plotting', task: 'Add AFM plotting.', current: 'First version plots data.', next: 'Adjust UI.' }, { homeDir: home });
  syncObsidian({ cwd: repo, homeDir: home });
  reviseUnit(repo, '5.3.8', {
    current: 'UI first revision is complete.', next: 'Add flatten.',
    history: [{ at: '2026-10-01T00:00:00.000Z', text: 'First version plots data.' }],
  }, { homeDir: home });
  syncObsidian({ cwd: repo, homeDir: home });

  const text = fs.readFileSync(note, 'utf8');
  assert.match(text, /Manual content stays here/);
  assert.equal(text.split(MANAGED_BEGIN).length - 1, 1);
  assert.equal(text.split(MANAGED_END).length - 1, 1);
  assert.match(text, /^## Branch: 5\.3\.8$/m);
  assert.doesNotMatch(text, /5\.3\.8 · AFM plotting/);
  assert.match(text, /UI first revision is complete/);
  assert.match(text, /- First version plots data\./);
});

test('legacy unit heading uses Branch prefix without repeating stored title', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, homeDir: home, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });

  const notePath = path.join(vault, '02 Projects', 'project - spinlab.md');
  const manual = '## Project definition\nThese notes belong to the user.\n';
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, manual);
  seedUnit(repo, {
    id: 'afm-workflow', title: 'AFM Plotting Workflow', task: 'Add plotting',
    current: 'First version works', next: 'Refine controls', started: '2026-09-20T03:06:17.792Z',
  }, { homeDir: home, updatedAt: '2026-09-20T03:06:17.792Z' });

  const first = syncObsidian({ cwd: repo, homeDir: home });
  assert.equal(first.unchanged, false);
  const text = fs.readFileSync(notePath, 'utf8');
  assert.ok(text.startsWith(manual));
  assert.match(text, /^## Branch: afm-workflow$/m);
  assert.doesNotMatch(text, /## afm-workflow · AFM Plotting Workflow/);
  assert.match(text, /\*\*Current\*\*\nFirst version works/);
  assert.match(text, /\*\*Next\*\*\nRefine controls/);
  assert.equal(text.split(unitMarkers('afm-workflow').begin).length - 1, 1);
  assert.equal(loadState(repo).tasks[0].title, 'AFM Plotting Workflow');

  const mtime = fs.statSync(notePath).mtimeMs;
  const second = syncObsidian({ cwd: repo, homeDir: home });
  assert.equal(second.unchanged, true);
  assert.equal(fs.statSync(notePath).mtimeMs, mtime);
  assert.equal(fs.readFileSync(notePath, 'utf8'), text);
});

test('Obsidian projection shows compact lifecycle dates while durable state keeps ISO timestamps', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });

  seedUnit(repo, {
    id: 'v5.3.8', title: '3ω Scaling vs Angle', task: 'Track angle scaling.',
    current: 'Work started.', started: '2026-09-20T03:06:20.245Z',
  }, { homeDir: home, updatedAt: '2026-09-20T03:06:20.245Z' });
  reviseUnit(repo, 'v5.3.8', {
    current: 'Work completed.', status: 'Completed', outcome: 'Merged', completed: '2026-09-21T15:41:08.000Z',
  }, { homeDir: home, updatedAt: '2026-09-21T15:41:08.000Z' });
  syncObsidian({ cwd: repo, homeDir: home });

  const note = fs.readFileSync(path.join(vault, '02 Projects', 'project - spinlab.md'), 'utf8');
  assert.match(note, /\*\*Started:\*\* 2026-09-20\n\*\*Updated at:\*\* 2026-09-21 23:41 SGT/);
  assert.match(note, /\*\*Completed:\*\* 2026-09-21/);
  assert.doesNotMatch(note, /2026-09-20T03:06:20\.245Z/);
  assert.doesNotMatch(note, /2026-09-21T15:41:08\.000Z/);

  const task = loadState(repo).tasks.find((entry) => entry.id === 'v5.3.8');
  assert.equal(task.started, '2026-09-20T03:06:20.245Z');
  assert.equal(task.completed, '2026-09-21T15:41:08.000Z');
});

test('missing Obsidian note is created as standard Markdown', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, projectName: 'ReviewLoop', summary: 'Independent review workflow.', obsidianNote: 'project - reviewloop.md' });
  seedUnit(repo, { id: '2.1.0', title: 'DocFlow integration', task: 'Integrate progress memory.' }, { homeDir: home });
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


function unitText(note, taskId) {
  const markers = unitMarkers(taskId);
  const start = note.indexOf(markers.begin);
  const endStart = note.indexOf(markers.end, start);
  assert.ok(start >= 0, `missing unit start for ${taskId}`);
  assert.ok(endStart > start, `missing unit end for ${taskId}`);
  return note.slice(start, endStart + markers.end.length);
}

test('two worktrees update independent units in one Obsidian project note', () => {
  const root = tempGitRepo();
  const parent = path.dirname(root);
  const afm = path.join(parent, `${path.basename(root)}-afm`);
  const scaling = path.join(parent, `${path.basename(root)}-scaling`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'afm-workflow', afm, 'HEAD']);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'v5.3.8', scaling, 'HEAD']);

  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });

  initRepo({ cwd: afm, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  seedUnit(afm, {
    id: 'afm-workflow', title: 'AFM Plotting Workflow', task: 'Add AFM plotting workflow.',
    current: 'AFM first version can plot data.', next: 'Add flatten.',
  }, { homeDir: home });
  syncObsidian({ cwd: afm, homeDir: home, taskId: 'afm-workflow' });

  const notePath = path.join(vault, '02 Projects', 'project - spinlab.md');
  const afterAfm = fs.readFileSync(notePath, 'utf8');
  const afmBeforeScaling = unitText(afterAfm, 'afm-workflow');

  initRepo({ cwd: scaling, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  syncObsidian({ cwd: scaling, homeDir: home });
  assert.equal(unitText(fs.readFileSync(notePath, 'utf8'), 'afm-workflow'), afmBeforeScaling);

  seedUnit(scaling, {
    id: 'v5.3.8', title: '3ω Scaling vs Angle', task: 'Adapt the 3ω scaling workflow for angle data.',
    current: 'Angle workflow adaptation has started.', next: 'Validate the scaling output.',
  }, { homeDir: home });
  syncObsidian({ cwd: scaling, homeDir: home, taskId: 'v5.3.8' });

  const both = fs.readFileSync(notePath, 'utf8');
  const scalingBeforeAfmCheckpoint = unitText(both, 'v5.3.8');

  reviseUnit(afm, 'afm-workflow', {
    current: 'AFM UI first revision is complete.', next: 'Add selectable flatten.',
    history: [{ at: '2026-10-01T00:00:00.000Z', text: 'AFM first version can plot data.' }],
  }, { homeDir: home });
  syncObsidian({ cwd: afm, homeDir: home, taskId: 'afm-workflow' });

  const afterAfmCheckpoint = fs.readFileSync(notePath, 'utf8');
  assert.match(unitText(afterAfmCheckpoint, 'afm-workflow'), /AFM UI first revision is complete/);
  assert.match(unitText(afterAfmCheckpoint, 'afm-workflow'), /- AFM first version can plot data\./);
  assert.equal(unitText(afterAfmCheckpoint, 'v5.3.8'), scalingBeforeAfmCheckpoint);

  const afmBeforeScalingCheckpoint = unitText(afterAfmCheckpoint, 'afm-workflow');
  reviseUnit(scaling, 'v5.3.8', {
    current: 'Angle scaling output is validated.', next: 'Refine the presentation.',
  }, { homeDir: home });
  syncObsidian({ cwd: scaling, homeDir: home, taskId: 'v5.3.8' });

  const finalNote = fs.readFileSync(notePath, 'utf8');
  assert.equal(unitText(finalNote, 'afm-workflow'), afmBeforeScalingCheckpoint);
  assert.match(unitText(finalNote, 'v5.3.8'), /Angle scaling output is validated/);
  assert.equal(finalNote.split('<!-- DOCFLOW:UNIT:afm-workflow:START -->').length - 1, 1);
  assert.equal(finalNote.split('<!-- DOCFLOW:UNIT:v5.3.8:START -->').length - 1, 1);
});


function runUpdateProcess({ cwd, homeDir, id, current, next }) {
  const coreUrl = new URL('../src/core.js', import.meta.url).href;
  const helpersUrl = new URL('./helpers.js', import.meta.url).href;
  const script = [
    `import { syncObsidian } from ${JSON.stringify(coreUrl)};`,
    `import { reviseUnit } from ${JSON.stringify(helpersUrl)};`,
    `reviseUnit(${JSON.stringify(cwd)}, ${JSON.stringify(id)}, ${JSON.stringify({ current, next })}, { homeDir: ${JSON.stringify(homeDir)} });`,
    `syncObsidian(${JSON.stringify({ cwd, homeDir, taskId: id })});`,
  ].join('\n');
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`update child failed (${code}): ${stderr}`));
    });
  });
}

test('concurrent worktree updates preserve both Project units', async () => {
  const root = tempGitRepo();
  const parent = path.dirname(root);
  const afm = path.join(parent, `${path.basename(root)}-concurrent-afm`);
  const scaling = path.join(parent, `${path.basename(root)}-concurrent-scaling`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'concurrent-afm', afm, 'HEAD']);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'concurrent-scaling', scaling, 'HEAD']);

  const home = tempHome();
  const vault = path.join(home, 'PhD');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });

  initRepo({ cwd: afm, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  seedUnit(afm, {
    id: 'afm-workflow', title: 'AFM Plotting Workflow', task: 'Add AFM plotting workflow.',
    current: 'AFM initial state.', next: 'AFM next.',
  }, { homeDir: home });
  syncObsidian({ cwd: afm, homeDir: home, taskId: 'afm-workflow' });

  initRepo({ cwd: scaling, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  seedUnit(scaling, {
    id: 'v5.3.8', title: '3ω Scaling vs Angle', task: 'Adapt angle scaling.',
    current: 'Scaling initial state.', next: 'Scaling next.',
  }, { homeDir: home });
  syncObsidian({ cwd: scaling, homeDir: home, taskId: 'v5.3.8' });

  await Promise.all([
    runUpdateProcess({
      cwd: afm,
      homeDir: home,
      id: 'afm-workflow',
      current: 'AFM concurrent checkpoint landed.',
      next: 'Continue AFM.',
    }),
    runUpdateProcess({
      cwd: scaling,
      homeDir: home,
      id: 'v5.3.8',
      current: 'Scaling concurrent checkpoint landed.',
      next: 'Continue scaling.',
    }),
  ]);

  const notePath = path.join(vault, '02 Projects', 'project - spinlab.md');
  const note = fs.readFileSync(notePath, 'utf8');
  assert.match(unitText(note, 'afm-workflow'), /AFM concurrent checkpoint landed/);
  assert.match(unitText(note, 'v5.3.8'), /Scaling concurrent checkpoint landed/);
});


test('legacy whole-project task sections migrate in place without duplication', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'PhD');
  const projects = path.join(vault, '02 Projects');
  fs.mkdirSync(projects, { recursive: true });
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  seedUnit(repo, {
    id: 'afm-workflow', title: 'AFM Plotting Workflow', task: 'Add AFM plotting workflow.',
    current: 'AFM current state from canonical DocFlow state.', next: 'Add selectable flatten.',
  }, { homeDir: home });

  const note = path.join(projects, 'project - spinlab.md');
  fs.writeFileSync(note, [
    '---',
    'type: project',
    '---',
    '',
    '## Project definition',
    'Manual content stays.',
    '',
    MANAGED_BEGIN,
    '<!-- Generated by DocFlow. Edit the repository source, not this block. -->',
    '',
    '## afm-workflow · AFM Plotting Workflow',
    '',
    '**Task:** Add AFM plotting workflow.',
    '**Started:** 2026-09-19T00:00:00.000Z',
    '**Status:** In progress',
    '',
    '**Current**',
    'Legacy stale current.',
    '',
    '**Next**',
    'Legacy stale next.',
    '',
    '**History**',
    '-',
    '',
    MANAGED_END,
    '',
  ].join('\n'));

  syncObsidian({ cwd: repo, homeDir: home, taskId: 'afm-workflow' });
  const text = fs.readFileSync(note, 'utf8');
  const markers = unitMarkers('afm-workflow');

  assert.equal(text.split('## Branch: afm-workflow\n').length - 1, 1);
  assert.doesNotMatch(text, /## afm-workflow · AFM Plotting Workflow/);
  assert.equal(text.split(markers.begin).length - 1, 1);
  assert.equal(text.split(markers.end).length - 1, 1);
  assert.match(text, /AFM current state from canonical DocFlow state\./);
  assert.doesNotMatch(text, /Legacy stale current\./);
  assert.match(text, /Manual content stays\./);
});


test('legacy branch-like units show their own durable time without rewriting unchanged notes', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'Vault');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, homeDir: home, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  const notePath = path.join(vault, '02 Projects', 'project - spinlab.md');
  const manual = '# My manual project notes\nDo not modify this content.\n';
  fs.mkdirSync(path.dirname(notePath), { recursive: true });
  fs.writeFileSync(notePath, manual);

  seedUnit(repo, {
    id: 'afm-workflow', title: 'AFM Plotting Workflow', task: 'Add AFM workflow',
    current: 'AFM controls ready', started: '2026-09-24T15:57:48.830Z',
  }, { homeDir: home, updatedAt: '2026-09-24T15:57:48.830Z' });
  seedUnit(repo, {
    id: 'v5.3.8', title: '3ω Scaling vs Angle', task: 'Analyze angle scaling',
    current: 'Angle selection ready', started: '2026-09-20T03:06:31.308Z',
  }, { homeDir: home, updatedAt: '2026-09-20T03:06:31.308Z' });

  const initial = syncObsidian({ cwd: repo, homeDir: home });
  assert.equal(initial.unchanged, false);
  const before = fs.readFileSync(notePath, 'utf8');
  assert.ok(before.startsWith(manual));
  assert.match(unitText(before, 'afm-workflow'), /\*\*Started:\*\* 2026-09-24\n\*\*Updated at:\*\* 2026-09-24 23:57 SGT\n\*\*Status:\*\*/);
  assert.match(unitText(before, 'v5.3.8'), /\*\*Updated at:\*\* 2026-09-20 11:06 SGT/);
  assert.match(before, /\*\*Current\*\*\nAFM controls ready/);

  const originalMtime = fs.statSync(notePath).mtimeMs;
  assert.equal(syncObsidian({ cwd: repo, homeDir: home }).unchanged, true);
  assert.equal(fs.readFileSync(notePath, 'utf8'), before);
  assert.equal(fs.statSync(notePath).mtimeMs, originalMtime);

  reviseUnit(repo, 'afm-workflow', { current: 'AFM rendering complete' }, { homeDir: home, updatedAt: '2026-10-10T00:19:00.000Z' });
  syncObsidian({ cwd: repo, homeDir: home });
  const after = fs.readFileSync(notePath, 'utf8');
  assert.ok(after.startsWith(manual));
  assert.match(unitText(after, 'afm-workflow'), /\*\*Updated at:\*\* 2026-10-10 08:19 SGT/);
  assert.equal(unitText(after, 'v5.3.8'), unitText(before, 'v5.3.8'));
});
