import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  MANAGED_BEGIN,
  MANAGED_END,
  beginRound,
  checkpoint,
  configureGlobal,
  gateStatus,
  initRepo,
  startTask,
  syncObsidian,
  unitMarkers,
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


test('checkpoint seals the fingerprint after an Obsidian projection inside the repository', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  configureGlobal({ homeDir: home, vault: repo, projectFolder: 'notes' });
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'M1', title: 'In-repo projection', task: 'Keep the projection in the repo.' });
  beginRound({ cwd: repo, id: 'M1' });
  fs.appendFileSync(path.join(repo, 'app.txt'), 'meaningful work\n');

  const result = checkpoint({
    cwd: repo,
    homeDir: home,
    current: 'Meaningful work is complete.',
    next: 'Continue with the next task.',
  });

  assert.equal(result.obsidian.skipped, false);
  assert.equal(result.obsidian.path, path.join(repo, 'notes', 'project - demo.md'));
  assert.equal(gateStatus({ cwd: repo }).status, 'READY');
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
  startTask({
    cwd: afm,
    id: 'afm-workflow',
    title: 'AFM Plotting Workflow',
    task: 'Add AFM plotting workflow.',
    current: 'AFM first version can plot data.',
    next: 'Add flatten.',
  });
  syncObsidian({ cwd: afm, homeDir: home, taskId: 'afm-workflow' });

  const notePath = path.join(vault, '02 Projects', 'project - spinlab.md');
  const afterAfm = fs.readFileSync(notePath, 'utf8');
  const afmBeforeScaling = unitText(afterAfm, 'afm-workflow');

  initRepo({ cwd: scaling, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  syncObsidian({ cwd: scaling, homeDir: home });
  assert.equal(unitText(fs.readFileSync(notePath, 'utf8'), 'afm-workflow'), afmBeforeScaling);

  startTask({
    cwd: scaling,
    id: 'v5.3.8',
    title: '3ω Scaling vs Angle',
    task: 'Adapt the 3ω scaling workflow for angle data.',
    current: 'Angle workflow adaptation has started.',
    next: 'Validate the scaling output.',
  });
  syncObsidian({ cwd: scaling, homeDir: home, taskId: 'v5.3.8' });

  const both = fs.readFileSync(notePath, 'utf8');
  const scalingBeforeAfmCheckpoint = unitText(both, 'v5.3.8');

  beginRound({ cwd: afm, id: 'afm-workflow' });
  fs.appendFileSync(path.join(afm, 'app.txt'), 'AFM UI work\n');
  checkpoint({
    cwd: afm,
    homeDir: home,
    id: 'afm-workflow',
    current: 'AFM UI first revision is complete.',
    next: 'Add selectable flatten.',
  });

  const afterAfmCheckpoint = fs.readFileSync(notePath, 'utf8');
  assert.match(unitText(afterAfmCheckpoint, 'afm-workflow'), /AFM UI first revision is complete/);
  assert.match(unitText(afterAfmCheckpoint, 'afm-workflow'), /- AFM first version can plot data\./);
  assert.equal(unitText(afterAfmCheckpoint, 'v5.3.8'), scalingBeforeAfmCheckpoint);

  const afmBeforeScalingCheckpoint = unitText(afterAfmCheckpoint, 'afm-workflow');
  beginRound({ cwd: scaling, id: 'v5.3.8' });
  fs.appendFileSync(path.join(scaling, 'app.txt'), 'scaling work\n');
  checkpoint({
    cwd: scaling,
    homeDir: home,
    id: 'v5.3.8',
    current: 'Angle scaling output is validated.',
    next: 'Refine the presentation.',
  });

  const finalNote = fs.readFileSync(notePath, 'utf8');
  assert.equal(unitText(finalNote, 'afm-workflow'), afmBeforeScalingCheckpoint);
  assert.match(unitText(finalNote, 'v5.3.8'), /Angle scaling output is validated/);
  assert.equal(finalNote.split('<!-- DOCFLOW:UNIT:afm-workflow:START -->').length - 1, 1);
  assert.equal(finalNote.split('<!-- DOCFLOW:UNIT:v5.3.8:START -->').length - 1, 1);
});


function runCheckpointProcess({ cwd, homeDir, id, current, next }) {
  const coreUrl = new URL('../src/core.js', import.meta.url).href;
  const script = [
    `import { checkpoint } from ${JSON.stringify(coreUrl)};`,
    `checkpoint(${JSON.stringify({ cwd, homeDir, id, current, next })});`,
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
      else reject(new Error(`checkpoint child failed (${code}): ${stderr}`));
    });
  });
}

test('concurrent worktree checkpoints preserve both Project units', async () => {
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
  startTask({
    cwd: afm,
    id: 'afm-workflow',
    title: 'AFM Plotting Workflow',
    task: 'Add AFM plotting workflow.',
    current: 'AFM initial state.',
    next: 'AFM next.',
  });
  syncObsidian({ cwd: afm, homeDir: home, taskId: 'afm-workflow' });

  initRepo({ cwd: scaling, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  startTask({
    cwd: scaling,
    id: 'v5.3.8',
    title: '3ω Scaling vs Angle',
    task: 'Adapt angle scaling.',
    current: 'Scaling initial state.',
    next: 'Scaling next.',
  });
  syncObsidian({ cwd: scaling, homeDir: home, taskId: 'v5.3.8' });

  beginRound({ cwd: afm, id: 'afm-workflow' });
  beginRound({ cwd: scaling, id: 'v5.3.8' });
  fs.appendFileSync(path.join(afm, 'app.txt'), 'parallel AFM work\n');
  fs.appendFileSync(path.join(scaling, 'app.txt'), 'parallel scaling work\n');

  await Promise.all([
    runCheckpointProcess({
      cwd: afm,
      homeDir: home,
      id: 'afm-workflow',
      current: 'AFM concurrent checkpoint landed.',
      next: 'Continue AFM.',
    }),
    runCheckpointProcess({
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
