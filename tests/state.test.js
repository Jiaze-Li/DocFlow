import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import {
  beginRound,
  checkpoint,
  gateStatus,
  initRepo,
  loadRuntime,
  loadState,
  startTask,
} from '../src/core.js';
import { tempGitRepo, tempHome } from './helpers.js';

test('Current changes append old fact to History while Next is rewritten from reality', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'SpinLab', obsidianNote: 'project - spinlab.md' });
  startTask({
    cwd: repo,
    id: '5.3.8',
    title: 'AFM plotting',
    task: 'Add AFM plotting to SpinLab.',
    current: 'First AFM version can plot data.',
    next: 'Adjust the UI.',
  });

  beginRound({ cwd: repo, id: '5.3.8' });
  fs.appendFileSync(path.join(repo, 'app.txt'), 'ui change\n');
  checkpoint({
    cwd: repo,
    id: '5.3.8',
    current: 'AFM UI first revision is complete.',
    next: 'Add selectable flatten.',
  });

  beginRound({ cwd: repo, id: '5.3.8' });
  fs.appendFileSync(path.join(repo, 'app.txt'), 'colorbar change\n');
  checkpoint({
    cwd: repo,
    id: '5.3.8',
    current: 'Colorbar behavior was adjusted first.',
    next: 'Continue with selectable flatten.',
  });

  const task = loadState(repo).tasks[0];
  assert.equal(task.current, 'Colorbar behavior was adjusted first.');
  assert.equal(task.next, 'Continue with selectable flatten.');
  assert.deepEqual(task.history.map((x) => x.text), [
    'First AFM version can plot data.',
    'AFM UI first revision is complete.',
  ]);
  assert.ok(!task.history.some((x) => x.text === 'Add selectable flatten.'));
});

test('gate is READY after checkpoint and PENDING after new work', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'M1', title: 'First task', task: 'Do one thing.' });
  beginRound({ cwd: repo, id: 'M1' });
  fs.appendFileSync(path.join(repo, 'app.txt'), 'work\n');
  checkpoint({ cwd: repo, current: 'The first thing is implemented.', next: 'Validate usage.' });
  assert.equal(gateStatus({ cwd: repo }).status, 'READY');
  fs.appendFileSync(path.join(repo, 'app.txt'), 'more work\n');
  assert.equal(gateStatus({ cwd: repo }).status, 'PENDING');
});

test('an open round is deterministically pending even before files change', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'M1', title: 'First task', task: 'Do one thing.' });
  beginRound({ cwd: repo, id: 'M1' });
  const gate = gateStatus({ cwd: repo });
  assert.equal(gate.status, 'PENDING');
  assert.match(gate.reason, /uncheckpointed round/);
});

test('terminal tasks record completion and cannot be silently reopened', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: '1.0.0', title: 'Release', task: 'Ship the release.', current: 'Ready for merge.' });
  checkpoint({ cwd: repo, current: 'Release merged.', next: '', status: 'Completed', outcome: 'Merged' });
  const task = loadState(repo).tasks[0];
  assert.equal(task.status, 'Completed');
  assert.equal(task.outcome, 'Merged');
  assert.ok(task.completed);
  assert.throws(() => checkpoint({ cwd: repo, current: 'Reopened.', next: 'More work', status: 'In progress' }), /cannot be reopened/);
});

test('repeating the same Current does not duplicate History', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'M1', title: 'Task', task: 'Task.', current: 'Same fact.' });
  checkpoint({ cwd: repo, current: 'Same fact.', next: 'Next A' });
  checkpoint({ cwd: repo, current: 'Same fact.', next: 'Next B' });
  assert.equal(loadState(repo).tasks[0].history.length, 0);
});


test('checkpoint rejects an explicit task id that differs from the active round', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'A', title: 'Task A', task: 'Do A.', current: 'A started.' });
  startTask({ cwd: repo, id: 'B', title: 'Task B', task: 'Do B.', current: 'B started.' });
  beginRound({ cwd: repo, id: 'A' });
  fs.appendFileSync(path.join(repo, 'app.txt'), 'work for A\n');

  assert.throws(
    () => checkpoint({ cwd: repo, id: 'B', current: 'Wrongly attributed work.', next: 'Bad next.' }),
    /active for A/,
  );

  const gate = gateStatus({ cwd: repo });
  assert.equal(gate.status, 'PENDING');
  assert.equal(gate.taskId, 'A');
  const state = loadState(repo);
  assert.equal(state.tasks.find((task) => task.id === 'B').current, 'B started.');
});

test('same-size changes to large untracked files invalidate a checkpoint', () => {
  const repo = tempGitRepo();
  initRepo({ cwd: repo, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({ cwd: repo, id: 'M1', title: 'Large artifact', task: 'Track large repo work.' });
  beginRound({ cwd: repo, id: 'M1' });

  const artifact = path.join(repo, 'large.bin');
  const size = 10 * 1024 * 1024 + 17;
  fs.writeFileSync(artifact, Buffer.alloc(size, 0x41));
  checkpoint({ cwd: repo, current: 'Large artifact was produced.', next: 'Inspect the result.' });
  assert.equal(gateStatus({ cwd: repo }).status, 'READY');

  fs.writeFileSync(artifact, Buffer.alloc(size, 0x42));
  assert.equal(gateStatus({ cwd: repo }).status, 'PENDING');
});


test('stale concurrent checkpoint is rejected instead of overwriting Current and History', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  initRepo({ cwd: repo, homeDir: home, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({
    cwd: repo,
    homeDir: home,
    id: 'shared',
    title: 'Shared task',
    task: 'Exercise same-unit concurrency.',
    current: 'Initial fact.',
    next: 'Initial next.',
  });

  let injected = false;
  const interleavingExec = (command, args, options) => {
    if (
      !injected
      && command === 'git'
      && Array.isArray(args)
      && args.includes('rev-parse')
      && args.includes('--git-common-dir')
    ) {
      injected = true;
      checkpoint({
        cwd: repo,
        homeDir: home,
        id: 'shared',
        current: 'Actor B checkpoint.',
        next: 'B next.',
      });
    }
    return execFileSync(command, args, options);
  };

  assert.throws(
    () => checkpoint({
      cwd: repo,
      homeDir: home,
      exec: interleavingExec,
      id: 'shared',
      current: 'Actor A stale checkpoint.',
      next: 'A next.',
    }),
    /durable state changed concurrently.*reload state and retry/,
  );
  assert.equal(injected, true);

  const task = loadState(repo).tasks.find((entry) => entry.id === 'shared');
  assert.equal(task.current, 'Actor B checkpoint.');
  assert.equal(task.next, 'B next.');
  assert.deepEqual(task.history.map((entry) => entry.text), ['Initial fact.']);
  assert.ok(!task.history.some((entry) => entry.text === 'Actor A stale checkpoint.'));
});

test('concurrent creation of the same task id fails closed', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  initRepo({ cwd: repo, homeDir: home, projectName: 'Demo', obsidianNote: 'project - demo.md' });

  let injected = false;
  const interleavingExec = (command, args, options) => {
    if (
      !injected
      && command === 'git'
      && Array.isArray(args)
      && args.includes('rev-parse')
      && args.includes('--git-common-dir')
    ) {
      injected = true;
      startTask({
        cwd: repo,
        homeDir: home,
        id: 'same-id',
        title: 'Actor B task',
        task: 'Created by actor B.',
        current: 'B created this task.',
      });
    }
    return execFileSync(command, args, options);
  };

  assert.throws(
    () => startTask({
      cwd: repo,
      homeDir: home,
      exec: interleavingExec,
      id: 'same-id',
      title: 'Actor A task',
      task: 'Created from a stale missing snapshot.',
      current: 'A should not overwrite B.',
    }),
    /durable state changed concurrently.*reload state and retry/,
  );
  assert.equal(injected, true);

  const task = loadState(repo).tasks.find((entry) => entry.id === 'same-id');
  assert.equal(task.title, 'Actor B task');
  assert.equal(task.current, 'B created this task.');
});

test('durable unit History survives feature worktree and branch deletion', () => {
  const root = tempGitRepo();
  const home = tempHome();
  const parent = path.dirname(root);
  const feature = path.join(parent, `${path.basename(root)}-afm-persistence`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'afm-workflow', feature, 'HEAD']);

  initRepo({
    cwd: feature,
    homeDir: home,
    projectName: 'SpinLab',
    obsidianNote: 'project - spinlab.md',
  });
  startTask({
    cwd: feature,
    homeDir: home,
    id: 'afm-workflow',
    title: 'AFM Plotting Workflow',
    task: 'Add AFM plotting.',
    current: 'AFM first version works.',
    next: 'Refine the UI.',
  });
  beginRound({ cwd: feature, id: 'afm-workflow' });
  fs.appendFileSync(path.join(feature, 'app.txt'), 'AFM work\n');
  checkpoint({
    cwd: feature,
    homeDir: home,
    id: 'afm-workflow',
    current: 'AFM UI refinement is complete.',
    next: 'Run regression tests.',
  });

  const before = loadState(feature).tasks.find((task) => task.id === 'afm-workflow');
  assert.deepEqual(before.history.map((entry) => entry.text), ['AFM first version works.']);

  execFileSync('git', ['-C', root, 'worktree', 'remove', '--force', feature]);
  execFileSync('git', ['-C', root, 'branch', '-D', 'afm-workflow']);

  const inspect = path.join(parent, `${path.basename(root)}-inspect-persistence`);
  execFileSync('git', ['-C', root, 'worktree', 'add', '-q', '-b', 'inspect-docflow-state', inspect, 'HEAD']);

  const after = loadState(inspect).tasks.find((task) => task.id === 'afm-workflow');
  assert.equal(after.current, 'AFM UI refinement is complete.');
  assert.equal(after.next, 'Run regression tests.');
  assert.deepEqual(after.history.map((entry) => entry.text), ['AFM first version works.']);

  const durable = execFileSync(
    'git',
    ['-C', root, 'show', 'docflow-state:.docflow/units/afm-workflow.json'],
    { encoding: 'utf8' },
  );
  assert.match(durable, /AFM UI refinement is complete/);
  assert.equal(execFileSync('git', ['-C', inspect, 'status', '--short', '.docflow'], { encoding: 'utf8' }), '');
});

test('legacy worktree-local state migrates losslessly and cleans the worktree', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const legacyDir = path.join(repo, '.docflow');
  fs.mkdirSync(legacyDir, { recursive: true });

  fs.writeFileSync(path.join(legacyDir, 'config.json'), JSON.stringify({
    schemaVersion: 1,
    projectName: 'SpinLab',
    obsidianNote: 'project - spinlab.md',
  }, null, 2));
  fs.writeFileSync(path.join(legacyDir, 'project.md'), '# SpinLab\n\n## Project\nLegacy project definition.\n');
  fs.writeFileSync(path.join(legacyDir, 'state.json'), JSON.stringify({
    schemaVersion: 1,
    activeTaskId: 'afm-workflow',
    tasks: [{
      id: 'afm-workflow',
      title: 'AFM Plotting Workflow',
      task: 'Add AFM plotting.',
      started: '2026-09-20T03:06:17.792Z',
      status: 'In progress',
      current: 'AFM UI is aligned.',
      next: 'Run regression tests.',
      history: [{ at: '2026-09-20T03:06:26.329Z', text: 'AFM first version can plot data.' }],
      completed: null,
      outcome: null,
    }],
    updatedAt: '2026-09-20T03:06:26.329Z',
  }, null, 2));
  fs.writeFileSync(path.join(legacyDir, 'runtime.json'), JSON.stringify({
    schemaVersion: 1,
    activeSession: null,
    lastCheckpoint: null,
  }, null, 2));

  const result = initRepo({ cwd: repo, homeDir: home });
  assert.equal(result.migratedLegacy, true);
  assert.deepEqual(result.migratedTaskIds, ['afm-workflow']);
  assert.equal(fs.existsSync(legacyDir), false);
  assert.equal(execFileSync('git', ['-C', repo, 'status', '--short', '.docflow'], { encoding: 'utf8' }), '');

  const task = loadState(repo).tasks.find((entry) => entry.id === 'afm-workflow');
  assert.equal(task.current, 'AFM UI is aligned.');
  assert.equal(task.next, 'Run regression tests.');
  assert.deepEqual(task.history.map((entry) => entry.text), ['AFM first version can plot data.']);
  assert.equal(loadRuntime(repo).activeTaskId, 'afm-workflow');

  const project = execFileSync('git', ['-C', repo, 'show', 'docflow-state:.docflow/project.md'], { encoding: 'utf8' });
  assert.match(project, /Legacy project definition/);
});
