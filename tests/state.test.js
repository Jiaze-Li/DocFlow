import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  beginRound,
  checkpoint,
  gateStatus,
  initRepo,
  loadState,
  startTask,
} from '../src/core.js';
import { tempGitRepo } from './helpers.js';

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
