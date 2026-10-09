import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MANAGED_BEGIN, MANAGED_END, configureGlobal, initRepo, renderTaskUnit, startTask, syncObsidian } from '../src/core.js';
import { AGENT_LABEL, catchUpAll, installSyncAgent, listRegisteredRepos, registerRepo, syncAgentStatus, uninstallSyncAgent } from '../src/catchup.js';
import { ingestPush } from '../src/ingest.js';
import { setupRepo } from '../src/setup-repo.js';
import { doctor } from '../src/doctor.js';
import { cloneGitRepo, tempBareGitRepo, tempGitRepo, tempHome } from './helpers.js';

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'docflow.js');
const ZERO = '0'.repeat(40);
const git = (repo, ...args) => execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
const head = (repo) => git(repo, 'rev-parse', 'HEAD');
const commitOn = (repo, message) => { git(repo, 'commit', '--allow-empty', '-q', '--no-verify', '-m', message); return head(repo); };

/** Producer clone + bare remote; the "CI runner" ingests pushes into docflow-state. */
function world() {
  const remote = tempBareGitRepo();
  const dev = tempGitRepo();
  const home = tempHome();
  git(dev, 'remote', 'add', 'origin', remote);
  git(dev, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
  execFileSync('git', ['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main']);
  git(dev, 'checkout', '-q', '-B', 'main');
  git(dev, 'branch', '-q', '--set-upstream-to=origin/main', 'main');
  initRepo({ cwd: dev, homeDir: home, projectName: 'Proj', obsidianNote: 'project - proj.md' });
  setupRepo({ cwd: dev, homeDir: home });
  const tips = new Map();
  const push = (branch, messages) => {
    if (tips.has(branch)) git(dev, 'checkout', '-q', branch);
    else git(dev, 'checkout', '-q', '-b', branch, 'main');
    const shas = messages.map((m) => commitOn(dev, m));
    git(dev, 'push', '-q', 'origin', branch);
    const runner = cloneGitRepo(remote);
    ingestPush({ cwd: runner, homeDir: tempHome(), ref: `refs/heads/${branch}`, before: tips.get(branch) ?? ZERO, after: shas.at(-1), defaultBranch: 'main' });
    tips.set(branch, shas.at(-1));
    return shas;
  };
  return { remote, dev, home, push };
}

/** A different Mac: a fresh clone with its own home and Obsidian vault. */
function consumer(remote, { note = 'project - proj.md' } = {}) {
  const repo = cloneGitRepo(remote);
  const home = tempHome();
  const vault = path.join(home, 'Vault');
  fs.mkdirSync(path.join(vault, '02 Projects'), { recursive: true });
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  return { repo, home, notePath: path.join(vault, '02 Projects', note) };
}

const cli = (args, home) => execFileSync(process.execPath, [CLI, ...args], { encoding: 'utf8', env: { ...process.env, HOME: home } });

test('every distinct SHA is projected in order; identical subjects stay distinct; only first lines; Next not fabricated', () => {
  const w = world();
  const shas = w.push('feat/ledger', ['Add upload retry\n\nLong body that must never reach Obsidian.', 'Tune upload retry', 'Add upload retry']);
  const c = consumer(w.remote);
  const out = JSON.parse(cli(['sync', '--refresh', '--cwd', c.repo, '--json'], c.home));
  assert.equal(out.synced, true);

  const note = fs.readFileSync(c.notePath, 'utf8');
  const block = note.slice(note.indexOf('<!-- DOCFLOW:UNIT:'));
  const adds = block.split('\n').filter((l) => l.startsWith('- Add upload retry'));
  assert.equal(adds.length, 1, 'older identical subject is in History once');
  assert.match(block, /### Current\nAdd upload retry \(`[0-9a-f]{7}`/);
  assert.ok(block.includes(`\`${shas[0].slice(0, 7)}\``) && block.includes(`\`${shas[1].slice(0, 7)}\``) && block.includes(`\`${shas[2].slice(0, 7)}\``));
  const historyOrder = block.split('### History')[1];
  assert.ok(historyOrder.indexOf(shas[0].slice(0, 7)) < historyOrder.indexOf(shas[1].slice(0, 7)));
  assert.doesNotMatch(note, /Long body that must never reach Obsidian/);
  assert.doesNotMatch(block, /### Next/);
  assert.match(block, /\*\*PR:\*\*\n/);
  assert.doesNotMatch(block, /\*\*Task:\*\*/);
});

test('branch presentation: empty PR line, Current then Next then History, PR merge status', () => {
  const base = {
    id: 'feat/presentation', branch: 'feat/presentation', title: 'feat/presentation',
    task: 'Development branch: feat/presentation', started: '2026-10-09T10:00:00Z',
    status: 'In progress', current: 'Implement branch view', next: 'Verify Obsidian rendering',
    history: [], pr: null, completed: null, outcome: null,
    commits: [
      { sha: 'a'.repeat(40), branch: 'feat/presentation', timestamp: '2026-10-09T10:00:00Z', message: 'Add branch view' },
      { sha: 'b'.repeat(40), branch: 'feat/presentation', timestamp: '2026-10-09T11:00:00Z', message: 'Implement branch view' },
    ],
  };
  const beforePr = renderTaskUnit(base);
  assert.match(beforePr, /## Branch: feat\/presentation/);
  assert.match(beforePr, /\*\*PR:\*\*\n/);
  assert.doesNotMatch(beforePr, /\*\*Task:\*\*/);
  assert.doesNotMatch(beforePr, /Development branch:/);
  assert.ok(beforePr.indexOf('### Current') < beforePr.indexOf('### Next'));
  assert.ok(beforePr.indexOf('### Next') < beforePr.indexOf('### History'));
  assert.match(beforePr, /- Add branch view \(`aaaaaaa`, 2026-10-09\)/);
  const afterMerge = renderTaskUnit({
    ...base, status: 'Completed', outcome: 'Merged', completed: '2026-10-10T09:00:00Z',
    next: '', pr: { number: 14, state: 'closed', merged: true, url: 'https://github.com/Jiaze-Li/reviewloop/pull/14' },
  });
  assert.match(afterMerge, /\*\*Status:\*\* Completed · Merged/);
  assert.match(afterMerge, /\*\*PR:\*\* \[#14\]\(https:\/\/github\.com\/Jiaze-Li\/reviewloop\/pull\/14\)/);
  assert.match(afterMerge, /\*\*Completed:\*\* 2026-10-10/);
  assert.doesNotMatch(afterMerge, /### Next/);
  const firstOnly = renderTaskUnit({ ...base, next: '', commits: base.commits.slice(0, 1) });
  assert.doesNotMatch(firstOnly, /### History/);
  assert.doesNotMatch(firstOnly, /### Next/);
});

test('repeated sync is byte-idempotent and manual content outside the managed block is preserved', () => {
  const w = world();
  w.push('feat/a', ['First change here', 'Second change here']);
  const c = consumer(w.remote);
  const manual = '---\ntype: project\n---\n\n## Project definition\nHand-written text.\n';
  fs.writeFileSync(c.notePath, manual);
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  const first = fs.readFileSync(c.notePath, 'utf8');
  assert.ok(first.startsWith(manual.trimEnd()));
  // Manual edits after the managed block must also survive further syncs.
  fs.writeFileSync(c.notePath, `${first}\n## My notes\nKeep me byte for byte.\n`);
  const edited = fs.readFileSync(c.notePath, 'utf8');
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  cli(['sync', '--cwd', c.repo], c.home);
  assert.equal(fs.readFileSync(c.notePath, 'utf8'), edited);
});

test('offline Mac catches up from durable state in a fresh process without loss or duplication', () => {
  const w = world();
  w.push('feat/offline', ['Change before the Mac slept']);
  const c = consumer(w.remote);
  registerRepo({ repoRoot: c.repo, homeDir: c.home });
  assert.equal(JSON.parse(cli(['catch-up'], c.home)).ok, true);
  const before = fs.readFileSync(c.notePath, 'utf8');
  assert.match(before, /Change before the Mac slept/);

  // Progress lands while this Mac is offline/asleep (no sync runs).
  w.push('feat/offline', ['Change one while offline', 'Change two while offline']);
  const run = JSON.parse(cli(['catch-up'], c.home));
  assert.equal(run.ok, true);
  assert.equal(run.repos[0].refreshed, true);
  const after = fs.readFileSync(c.notePath, 'utf8');
  for (const subject of ['Change before the Mac slept', 'Change one while offline', 'Change two while offline']) {
    assert.equal(after.split(subject).length - 1, 1, `${subject} appears exactly once`);
  }
  assert.equal(JSON.parse(cli(['catch-up'], c.home)).ok, true);
  assert.equal(fs.readFileSync(c.notePath, 'utf8'), after, 'idempotent');
});

test('when origin is unreachable catch-up still projects the newest local durable state', () => {
  const w = world();
  w.push('feat/net', ['Recorded before losing network']);
  const c = consumer(w.remote);
  registerRepo({ repoRoot: c.repo, homeDir: c.home });
  cli(['catch-up'], c.home);
  fs.rmSync(c.notePath);
  git(c.repo, 'remote', 'set-url', 'origin', path.join(c.home, 'gone.git'));
  const run = JSON.parse(cli(['catch-up'], c.home));
  assert.equal(run.repos[0].offline, true);
  assert.equal(run.repos[0].synced, true);
  assert.match(fs.readFileSync(c.notePath, 'utf8'), /Recorded before losing network/);
});

test('independent units never overwrite each other', () => {
  const w = world();
  w.push('feat/one', ['Unit one first', 'Unit one second']);
  w.push('feat/two', ['Unit two first']);
  const c = consumer(w.remote);
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  const note = fs.readFileSync(c.notePath, 'utf8');
  assert.match(note, /## Branch: feat\/one/);
  assert.match(note, /## Branch: feat\/two/);
  assert.match(note, /Unit one second/);
  assert.match(note, /Unit two first/);
  w.push('feat/two', ['Unit two next']);
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  const again = fs.readFileSync(c.notePath, 'utf8');
  assert.match(again, /Unit one second/);
  assert.match(again, /Unit two next/);
});

test('a malformed managed block fails closed and leaves the note untouched', () => {
  const w = world();
  w.push('feat/bad', ['Some real change']);
  const c = consumer(w.remote);
  fs.writeFileSync(c.notePath, `# Note\n${MANAGED_BEGIN}\nbroken, no end marker\n`);
  const before = fs.readFileSync(c.notePath, 'utf8');
  assert.throws(() => cli(['sync', '--refresh', '--cwd', c.repo], c.home), /Command failed/);
  assert.equal(fs.readFileSync(c.notePath, 'utf8'), before);
  const run = catchUpAll({ homeDir: (registerRepo({ repoRoot: c.repo, homeDir: c.home }), c.home) });
  assert.equal(run.ok, false);
  assert.match(run.repos[0].error, /malformed|duplicate/i);
  assert.equal(fs.readFileSync(c.notePath, 'utf8'), before);
});

test('v1 units without commits render exactly as before', () => {
  const repo = tempGitRepo();
  const home = tempHome();
  const vault = path.join(home, 'Vault');
  configureGlobal({ homeDir: home, vault, projectFolder: '02 Projects' });
  initRepo({ cwd: repo, homeDir: home, projectName: 'Legacy', obsidianNote: 'project - legacy.md' });
  startTask({ cwd: repo, homeDir: home, id: 'v1', title: 'Legacy task', task: 'Old flow.', current: 'Legacy current.', next: 'Legacy next.' });
  syncObsidian({ cwd: repo, homeDir: home });
  const note = fs.readFileSync(path.join(vault, '02 Projects', 'project - legacy.md'), 'utf8');
  assert.match(note, /\*\*Current\*\*\nLegacy current\./);
  assert.match(note, /\*\*Next\*\*\nLegacy next\./);
  assert.doesNotMatch(note, /`[0-9a-f]{7}`/);
});

test('one broken repository does not stop catch-up of the others; registry is idempotent', () => {
  const w = world();
  w.push('feat/ok', ['Healthy repo change']);
  const c = consumer(w.remote);
  registerRepo({ repoRoot: c.repo, homeDir: c.home });
  registerRepo({ repoRoot: c.repo, homeDir: c.home });
  registerRepo({ repoRoot: path.join(c.home, 'deleted-repo'), homeDir: c.home });
  assert.equal(listRegisteredRepos(c.home).length, 2);
  const run = catchUpAll({ homeDir: c.home });
  assert.equal(run.ok, false);
  const healthy = run.repos.find((r) => r.repoRoot === path.resolve(c.repo));
  assert.equal(healthy.synced, true);
  assert.match(fs.readFileSync(c.notePath, 'utf8'), /Healthy repo change/);
});

test('sync agent: written but never loaded, status tracks drift, doctor reports it', () => {
  const home = tempHome();
  assert.equal(syncAgentStatus({ homeDir: home }).state, 'missing');
  const res = installSyncAgent({ homeDir: home, intervalSeconds: 300 });
  const plist = fs.readFileSync(res.plist, 'utf8');
  assert.match(plist, new RegExp(`<string>${AGENT_LABEL}</string>`));
  assert.match(plist, /<string>catch-up<\/string>/);
  assert.match(plist, /<key>StartInterval<\/key><integer>300<\/integer>/);
  assert.match(res.loadCommand, /launchctl bootstrap/);
  assert.equal(syncAgentStatus({ homeDir: home }).state, 'current');
  assert.throws(() => installSyncAgent({ homeDir: home, intervalSeconds: 5 }), /between 60 and 86400/);
  fs.writeFileSync(res.plist, plist.replace('catch-up', 'something-else'));
  assert.equal(syncAgentStatus({ homeDir: home }).state, 'stale');
  const check = doctor({ cwd: home, homeDir: home }).checks.find((x) => x.name === 'sync_agent');
  assert.match(check.detail, /stale/);
  assert.equal(uninstallSyncAgent({ homeDir: home }).removed, true);
  assert.equal(syncAgentStatus({ homeDir: home }).state, 'missing');
});

test('commit subjects containing DocFlow markers cannot corrupt the managed block (sync keeps working)', () => {
  const w = world();
  w.push('feat/markers', ['Docs mention <!-- DOCFLOW:END --> and <!-- DOCFLOW:UNIT:x:START --> literally', 'Plain follow-up change']);
  const c = consumer(w.remote);
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  cli(['sync', '--cwd', c.repo], c.home);
  const note = fs.readFileSync(c.notePath, 'utf8');
  assert.equal(note.split(MANAGED_BEGIN).length - 1, 1);
  assert.equal(note.split(MANAGED_END).length - 1, 1);
  assert.equal(note.split('<!-- DOCFLOW:UNIT:x:START -->').length - 1, 0);
  assert.match(note, /Docs mention/);
  w.push('feat/markers', ['One more change after the odd subject']);
  cli(['sync', '--refresh', '--cwd', c.repo], c.home);
  assert.match(fs.readFileSync(c.notePath, 'utf8'), /One more change after the odd subject/);
});
