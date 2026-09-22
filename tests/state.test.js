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
import { cloneGitRepo, tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

function attachOrigin(repo, remote) {
  execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', remote]);
  execFileSync('git', ['-C', repo, 'push', '-q', 'origin', 'HEAD:refs/heads/main']);
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
}


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


test('durable state writes auto-push to origin/docflow-state', () => {
  const repo = tempGitRepo();
  const remote = tempBareGitRepo();
  const home = tempHome();
  attachOrigin(repo, remote);

  initRepo({ cwd: repo, homeDir: home, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  const initRemote = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/config.json'],
    { encoding: 'utf8' },
  );
  assert.match(initRemote, /"projectName": "Demo"/);

  startTask({
    cwd: repo,
    homeDir: home,
    id: 'M1',
    title: 'Remote-backed task',
    task: 'Verify automatic durable-state backup.',
    current: 'Initial state.',
  });
  checkpoint({
    cwd: repo,
    homeDir: home,
    id: 'M1',
    current: 'Checkpoint reached remote state.',
    next: 'Continue.',
  });

  const remoteUnit = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/M1.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteUnit, /Checkpoint reached remote state\./);

  const local = execFileSync('git', ['-C', repo, 'rev-parse', 'refs/heads/docflow-state'], { encoding: 'utf8' }).trim();
  const tracked = execFileSync('git', ['-C', repo, 'rev-parse', 'refs/remotes/origin/docflow-state'], { encoding: 'utf8' }).trim();
  const remoteHead = execFileSync('git', ['--git-dir', remote, 'rev-parse', 'refs/heads/docflow-state'], { encoding: 'utf8' }).trim();
  assert.equal(local, remoteHead);
  assert.equal(tracked, remoteHead);
});

test('auto-push supports SHA-256 Git repositories', () => {
  const repo = tempGitRepo({ objectFormat: 'sha256' });
  const remote = tempBareGitRepo({ objectFormat: 'sha256' });
  const home = tempHome();
  attachOrigin(repo, remote);

  initRepo({ cwd: repo, homeDir: home, projectName: 'SHA Demo', obsidianNote: 'project - sha-demo.md' });
  startTask({
    cwd: repo,
    homeDir: home,
    id: 'sha-unit',
    title: 'SHA-256 state',
    task: 'Verify SHA-256 object IDs are accepted.',
    current: 'Published from a SHA-256 repository.',
  });

  const remoteUnit = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/sha-unit.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteUnit, /Published from a SHA-256 repository\./);
});

test('concurrent initialization fails closed instead of overwriting newly published state', () => {
  const first = tempGitRepo();
  const remote = tempBareGitRepo();
  attachOrigin(first, remote);

  // Both clones begin life before origin/docflow-state exists.
  const second = cloneGitRepo(remote);
  const firstHome = tempHome();
  const secondHome = tempHome();

  let lsRemoteCalls = 0;
  let injected = false;
  const racingExec = (command, args, options) => {
    if (
      command === 'git'
      && Array.isArray(args)
      && args.includes('ls-remote')
      && args.includes('origin')
    ) {
      lsRemoteCalls += 1;
      if (!injected && lsRemoteCalls === 2) {
        injected = true;
        initRepo({
          cwd: first,
          homeDir: firstHome,
          projectName: 'Canonical Demo',
          obsidianNote: 'project - canonical-demo.md',
        });
      }
    }
    return execFileSync(command, args, options);
  };

  assert.throws(
    () => initRepo({
      cwd: second,
      homeDir: secondHome,
      exec: racingExec,
      projectName: 'Conflicting Demo',
      obsidianNote: 'project - conflicting-demo.md',
    }),
    /durable state changed concurrently.*\.docflow\/config\.json/s,
  );
  assert.equal(injected, true);

  const remoteConfig = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/config.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteConfig, /\"projectName\": \"Canonical Demo\"/);
  assert.doesNotMatch(remoteConfig, /Conflicting Demo/);
});

test('init discovers origin/docflow-state created after the clone was made', () => {
  const first = tempGitRepo();
  const remote = tempBareGitRepo();
  attachOrigin(first, remote);

  // Clone before DocFlow state exists, so this clone has no remote-tracking
  // docflow-state ref yet.
  const second = cloneGitRepo(remote);
  const firstHome = tempHome();
  const secondHome = tempHome();

  initRepo({
    cwd: first,
    homeDir: firstHome,
    projectName: 'Canonical Demo',
    obsidianNote: 'project - canonical-demo.md',
  });

  const result = initRepo({ cwd: second, homeDir: secondHome });
  assert.equal(result.alreadyInitialized, true);
  assert.equal(result.config.projectName, 'Canonical Demo');
  assert.equal(result.config.obsidianNote, 'project - canonical-demo.md');

  const remoteConfig = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/config.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteConfig, /"projectName": "Canonical Demo"/);
  assert.doesNotMatch(remoteConfig, /"projectName": "repo"/);
});

test('remote updates to other units are incorporated before an automatic push', () => {
  const first = tempGitRepo();
  const remote = tempBareGitRepo();
  const firstHome = tempHome();
  attachOrigin(first, remote);

  initRepo({ cwd: first, homeDir: firstHome, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({
    cwd: first,
    homeDir: firstHome,
    id: 'A',
    title: 'Task A',
    task: 'Create A.',
    current: 'A exists.',
  });

  const second = cloneGitRepo(remote);
  const secondHome = tempHome();
  initRepo({ cwd: second, homeDir: secondHome });
  startTask({
    cwd: second,
    homeDir: secondHome,
    id: 'B',
    title: 'Task B',
    task: 'Create B.',
    current: 'B exists.',
  });

  // first still has the pre-B local state. A write to a different unit must
  // refresh origin/docflow-state, preserve B, and then append C.
  startTask({
    cwd: first,
    homeDir: firstHome,
    id: 'C',
    title: 'Task C',
    task: 'Create C.',
    current: 'C exists.',
  });

  const state = loadState(first);
  assert.deepEqual(state.tasks.map((task) => task.id).sort(), ['A', 'B', 'C']);

  const remoteB = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/B.json'],
    { encoding: 'utf8' },
  );
  const remoteC = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/C.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteB, /B exists\./);
  assert.match(remoteC, /C exists\./);
});

test('a remote advance during push is rejected without advancing local state', () => {
  const first = tempGitRepo();
  const remote = tempBareGitRepo();
  const firstHome = tempHome();
  attachOrigin(first, remote);

  initRepo({ cwd: first, homeDir: firstHome, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({
    cwd: first,
    homeDir: firstHome,
    id: 'A',
    title: 'Task A',
    task: 'Seed state.',
    current: 'A exists.',
  });

  const second = cloneGitRepo(remote);
  const secondHome = tempHome();
  initRepo({ cwd: second, homeDir: secondHome });

  const localBefore = execFileSync(
    'git',
    ['-C', first, 'rev-parse', 'refs/heads/docflow-state'],
    { encoding: 'utf8' },
  ).trim();

  let injected = false;
  const racingExec = (command, args, options) => {
    if (
      !injected
      && command === 'git'
      && Array.isArray(args)
      && args.includes('push')
      && args.includes('origin')
    ) {
      injected = true;
      startTask({
        cwd: second,
        homeDir: secondHome,
        id: 'B',
        title: 'Remote task B',
        task: 'Advance the remote during another actor push.',
        current: 'B reached remote first.',
      });
    }
    return execFileSync(command, args, options);
  };

  assert.throws(
    () => startTask({
      cwd: first,
      homeDir: firstHome,
      exec: racingExec,
      id: 'C',
      title: 'Local task C',
      task: 'Lose the remote push race.',
      current: 'C must not become local durable state after rejection.',
    }),
    /push failed.*never force-pushes docflow-state/s,
  );
  assert.equal(injected, true);

  const localAfter = execFileSync(
    'git',
    ['-C', first, 'rev-parse', 'refs/heads/docflow-state'],
    { encoding: 'utf8' },
  ).trim();
  assert.equal(localAfter, localBefore);

  const remoteB = execFileSync(
    'git',
    ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/B.json'],
    { encoding: 'utf8' },
  );
  assert.match(remoteB, /B reached remote first\./);
  assert.throws(
    () => execFileSync(
      'git',
      ['--git-dir', remote, 'show', 'docflow-state:.docflow/units/C.json'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ),
  );
});

test('remote same-unit advancement makes a stale checkpoint fail closed', () => {
  const first = tempGitRepo();
  const remote = tempBareGitRepo();
  const firstHome = tempHome();
  attachOrigin(first, remote);

  initRepo({ cwd: first, homeDir: firstHome, projectName: 'Demo', obsidianNote: 'project - demo.md' });
  startTask({
    cwd: first,
    homeDir: firstHome,
    id: 'shared',
    title: 'Shared task',
    task: 'Exercise cross-clone concurrency.',
    current: 'Initial fact.',
  });

  const second = cloneGitRepo(remote);
  const secondHome = tempHome();
  initRepo({ cwd: second, homeDir: secondHome });

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
        cwd: second,
        homeDir: secondHome,
        id: 'shared',
        current: 'Remote actor checkpoint.',
        next: 'Remote next.',
      });
    }
    return execFileSync(command, args, options);
  };

  assert.throws(
    () => checkpoint({
      cwd: first,
      homeDir: firstHome,
      exec: interleavingExec,
      id: 'shared',
      current: 'Stale local checkpoint.',
      next: 'Stale next.',
    }),
    /durable state changed concurrently.*reload state and retry/,
  );
  assert.equal(injected, true);

  const task = loadState(first).tasks.find((entry) => entry.id === 'shared');
  assert.equal(task.current, 'Remote actor checkpoint.');
  assert.equal(task.next, 'Remote next.');
  assert.deepEqual(task.history.map((entry) => entry.text), ['Initial fact.']);
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
