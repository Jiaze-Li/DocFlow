// Deterministic GitHub ingestion: turns a push / pull_request event into durable commit
// progress on docflow-state. Git operations, validation and durable writes only; no model.
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import {
  commitStateFiles,
  readStateFile,
  STATE_BRANCH,
} from './state-store.js';
import {
  getBranchUnit,
  isDevelopmentBranch,
  loadRepoConfig,
  normalizeBranchName,
  recordCommitsProgress,
  recordPullRequestEvent,
  resolveBaseBranchShas,
  resolveRepoRoot,
} from './core.js';
import { validateCommitMessage } from './validator.js';

export const ACTIVATION_PATH = '.docflow/activation.json';
const ZERO_SHA = /^0+$/;
const MAX_ACTIVATION_BRANCHES = 5000;
const MAX_MERGED_WALK = 500;

function git(repoRoot, args, exec = execFileSync, { allowFailure = false } = {}) {
  try {
    return String(exec('git', ['-C', repoRoot, ...args], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 128 * 1024 * 1024,
    }) ?? '');
  } catch (error) {
    if (allowFailure) return '';
    const detail = error?.stderr ? String(error.stderr).trim() : error?.message;
    throw new Error(`git ${args.join(' ')} failed${detail ? `: ${detail}` : ''}`);
  }
}

function commitExists(repoRoot, sha, exec) {
  return Boolean(sha) && Boolean(git(repoRoot, ['rev-parse', '--verify', '--quiet', `${sha}^{commit}`], exec, { allowFailure: true }).trim());
}

function isAncestor(repoRoot, ancestor, descendant, exec) {
  try {
    exec('git', ['-C', repoRoot, 'merge-base', '--is-ancestor', ancestor, descendant], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Record which branches already existed when commit-native tracking was switched on. */
export function activateCommitNative({
  cwd = process.cwd(), now = new Date(), exec = execFileSync, homeDir = os.homedir(), branches = null,
} = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  if (!loadRepoConfig(repoRoot, exec)) throw new Error('DocFlow is not enabled in this repository');
  const existing = readActivation(repoRoot, exec);
  if (existing) return { repoRoot, activation: existing, created: false };
  // name -> tip SHA at activation time. The tip is the anchor that lets a later push recover
  // a first post-activation run that was lost (see selectNewCommits).
  const tips = {};
  if (branches) {
    for (const name of branches) {
      const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`], exec, { allowFailure: true }).trim();
      if (sha) tips[name] = sha;
    }
  } else {
    for (const line of git(repoRoot, ['ls-remote', '--heads', 'origin'], exec, { allowFailure: true }).split('\n')) {
      const [sha, ref] = line.trim().split(/\s+/);
      if (sha && /^[0-9a-f]{40,64}$/i.test(sha) && ref?.startsWith('refs/heads/')) tips[ref.slice('refs/heads/'.length)] = sha.toLowerCase();
    }
  }
  const names = branches ?? Object.keys(tips);
  const kept = [...new Set(names)].filter((n) => n.length <= 200).sort().slice(0, MAX_ACTIVATION_BRANCHES);
  const activation = {
    schemaVersion: 1,
    activatedAt: (now instanceof Date ? now : new Date(now)).toISOString(),
    branches: kept,
    tips: Object.fromEntries(kept.filter((n) => tips[n]).map((n) => [n, tips[n]])),
  };
  commitStateFiles({
    repoRoot, homeDir, exec,
    files: { [ACTIVATION_PATH]: `${JSON.stringify(activation, null, 2)}\n` },
    expectedFiles: { [ACTIVATION_PATH]: null },
    message: 'DocFlow: activate commit-native progress',
    allowCreate: false,
  });
  return { repoRoot, activation, created: true };
}

export function readActivation(repoRoot, exec = execFileSync) {
  const text = readStateFile(repoRoot, ACTIVATION_PATH, exec);
  if (text == null) return null;
  const value = JSON.parse(text);
  if (!value || value.schemaVersion !== 1 || !Array.isArray(value.branches)) throw new Error('Invalid DocFlow activation record');
  // `tips` is additive: records written before it existed simply have none (legacy format).
  if (value.tips != null && (typeof value.tips !== 'object' || Array.isArray(value.tips)
    || Object.values(value.tips).some((sha) => !/^[0-9a-f]{40,64}$/i.test(String(sha))))) {
    throw new Error('Invalid DocFlow activation record');
  }
  return value;
}

// Tips of branches that already existed when commit-native tracking was activated. Their
// history is pre-v2 and must never be backfilled into another branch. Branches created after
// activation are deliberately NOT excluded: commits shared by two such branches are recorded
// by whichever ingestion runs first (SHA dedup), so neither run can drop them.
function preActivationTips(repoRoot, branch, activation, exec) {
  const tips = new Set();
  for (const name of activation.branches) {
    if (name === branch || name === STATE_BRANCH) continue;
    const sha = git(repoRoot, ['rev-parse', '--verify', '--quiet', `refs/remotes/origin/${name}^{commit}`], exec, { allowFailure: true }).trim();
    if (sha) tips.add(sha);
  }
  return [...tips];
}

// A delayed FIRST delivery for a branch that has meanwhile been merged: its tip is now
// reachable from base, so base exclusion would erase it. Ownership is proven only by merge
// commit evidence: the earliest first-parent commit M on base that contains the tip must have
// the tip on a non-first parent. The branch's own commits are then exactly `tip --not M^1`,
// so no base history can enter. Anything else (a branch cut from base, a fast-forward or a
// base commit with no merge evidence) yields nothing, exactly as before.
function mergedBranchCommits(repoRoot, after, baseShas, exec) {
  for (const base of baseShas) {
    if (!isAncestor(repoRoot, after, base, exec)) continue;
    const chain = git(repoRoot, ['rev-list', '--first-parent', '--ancestry-path', `${after}..${base}`], exec, { allowFailure: true })
      .split('\n').map((l) => l.trim()).filter(Boolean);
    const merge = chain.at(-1);
    if (!merge) continue;
    const parents = git(repoRoot, ['rev-list', '--parents', '-n', '1', merge], exec).trim().split(/\s+/).slice(1);
    if (parents.length < 2) continue;
    const viaSecondParent = parents.slice(1).some((p) => isAncestor(repoRoot, after, p, exec));
    if (!viaSecondParent) continue;
    const walked = git(repoRoot, ['rev-list', '--topo-order', '--reverse', after, '--not', parents[0]], exec)
      .split('\n').map((l) => l.trim()).filter(Boolean);
    if (!walked.length || walked.length > MAX_MERGED_WALK) continue;
    return walked;
  }
  return [];
}

/**
 * Decide which commits a push newly introduces to the progress stream (oldest first).
 * - known unit with commits: everything reachable from `after` that the unit has not
 *   recorded (reconciles a missed run without touching older history);
 * - branch created after activation (or `before` is all zeros): every commit not already
 *   on baseline / other branches;
 * - branch that predates activation: forward-only (`before..after`), never a backfill.
 */
export function selectNewCommits(repoRoot, {
  branch, before = null, after, defaultBranch = null, exec = execFileSync,
}) {
  const unit = getBranchUnit(repoRoot, branch, exec);
  const recorded = (unit?.commits || []).map((c) => c.sha).filter((sha) => commitExists(repoRoot, sha, exec));
  const activation = readActivation(repoRoot, exec);
  if (!activation) throw new Error('Commit-native progress is not activated (run `docflow setup-repo`)');
  const exclusions = new Set([
    ...resolveBaseBranchShas(repoRoot, exec, defaultBranch),
    ...preActivationTips(repoRoot, branch, activation, exec),
  ]);
  // NB: a single `--not` negates everything after it; repeating it would toggle back.
  const notArgs = (extra) => {
    const shas = [...new Set([...exclusions, ...extra])];
    return shas.length ? ['--not', ...shas] : [];
  };
  const revList = (args) => git(repoRoot, ['rev-list', '--topo-order', '--reverse', ...args], exec)
    .split('\n').map((l) => l.trim()).filter(Boolean);
  const list = (extra) => revList([after, ...notArgs(extra)]);

  const hasBefore = before && !ZERO_SHA.test(before);
  const baseTips = resolveBaseBranchShas(repoRoot, exec, defaultBranch);
  const preExistingBranch = activation.branches.includes(branch);
  if (!unit?.commits?.length && baseTips.some((base) => isAncestor(repoRoot, after, base, exec))) {
    const owned = mergedBranchCommits(repoRoot, after, baseTips, exec);
    if (owned.length) return { mode: 'create-merged', shas: owned, owned };
  }
  if (unit?.commits?.length) {
    const baseShas = resolveBaseBranchShas(repoRoot, exec, defaultBranch);
    const onBase = baseShas.some((base) => isAncestor(repoRoot, after, base, exec));
    if (!onBase) return { mode: 'reconcile', shas: list(recorded) };
    // The tip already merged into base (a delayed delivery for a known unit). Base cannot be
    // used as an exclusion now, so walk only the branch's own first-parent chain, bounded by
    // what is recorded and by the fork point of the unit's first recorded commit.
    const first = recorded[0];
    const forkParents = first
      ? git(repoRoot, ['rev-list', '--parents', '-n', '1', first], exec).trim().split(/\s+/).slice(1)
      : [];
    // Fail closed: if no recorded commit is connected to the merged tip, or the walk is
    // implausibly long, we cannot prove these commits belong to the branch; record only the
    // tip instead of risking a backfill of base history.
    const connected = recorded.some((sha) => isAncestor(repoRoot, sha, after, exec));
    const walked = connected ? revList(['--first-parent', after, '--not', ...recorded, ...forkParents]) : [];
    if (!connected || walked.length > MAX_MERGED_WALK) return { mode: 'reconcile-merged-tip', shas: [after] };
    return { mode: 'reconcile-merged', shas: walked };
  }
  // A branch that predates activation and has no recorded commits yet: anchor on the tip it
  // had at activation time so a lost first run is recovered, never on pre-activation history.
  let recovery = null;
  if (preExistingBranch) {
    const anchor = activation.tips?.[branch] ?? null;
    if (anchor && commitExists(repoRoot, anchor, exec) && isAncestor(repoRoot, anchor, after, exec)) {
      return { mode: 'forward', shas: list([anchor]), recovery: { anchored: true } };
    }
    recovery = {
      anchored: false,
      legacyActivation: activation.tips == null,
      note: activation.tips == null
        ? 'Activation record has no branch tips (legacy format): a lost earlier run on this pre-existing branch cannot be recovered; recorded forward-only.'
        : (anchor
          ? 'Activation anchor is not an ancestor of the pushed tip (history was rewritten) or is unavailable: a lost earlier run cannot be recovered; recorded forward-only.'
          : 'No activation anchor was recorded for this branch: a lost earlier run cannot be recovered; recorded forward-only.'),
    };
  }
  const withRecovery = (selection) => (recovery ? { ...selection, recovery } : selection);
  if (!hasBefore) {
    // Unknown `before` (e.g. a PR event) on a pre-existing branch: only the tip is new.
    if (before == null && preExistingBranch) return withRecovery({ mode: 'tip', shas: [after] });
    return withRecovery({ mode: 'create', shas: list([]) });
  }
  if (!preExistingBranch) {
    return { mode: 'create-missed', shas: list([]) };
  }
  if (!commitExists(repoRoot, before, exec)) return withRecovery({ mode: 'tip', shas: [after] });
  return withRecovery({ mode: 'forward', shas: list([before]) });
}

function loadCommitFacts(repoRoot, shas, exec) {
  return shas.map((sha) => {
    const raw = git(repoRoot, ['log', '-1', '--format=%cI%x00%B', sha], exec);
    const split = raw.indexOf('\0');
    const timestamp = raw.slice(0, split).trim();
    const message = raw.slice(split + 1).replace(/\n+$/, '');
    return { sha, timestamp, message };
  });
}

function withRetry(fn, { attempts = 8, delayMs = 300 } = {}) {
  let last;
  for (let i = 0; i < attempts; i += 1) {
    try {
      return fn();
    } catch (error) {
      last = error;
      if (!/durable state|diverged|push failed|Timed out waiting/i.test(String(error?.message))) throw error;
      sleepSync(delayMs * (i + 1) + Math.floor(Math.random() * delayMs));
    }
  }
  throw last;
}

/** Ingest a branch push. `before`/`after` come from the GitHub push event. */
export function ingestPush({
  cwd = process.cwd(), ref, before = null, after, deleted = false, defaultBranch = null,
  now = new Date(), exec = execFileSync, homeDir = os.homedir(),
} = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  if (!loadRepoConfig(repoRoot, exec)) return { repoRoot, skipped: true, reason: 'DocFlow is not enabled in this repository' };
  if (!String(ref ?? '').startsWith('refs/heads/')) return { repoRoot, skipped: true, reason: `Not a branch ref: ${ref}` };
  const branch = normalizeBranchName(ref);
  if (deleted || !after || ZERO_SHA.test(after)) return { repoRoot, skipped: true, reason: 'Branch deletion never changes durable progress' };
  if (!isDevelopmentBranch(branch, { repoRoot, exec, defaultBranch })) return { repoRoot, skipped: true, reason: `Branch '${branch}' is not a development branch` };
  if (!commitExists(repoRoot, after, exec)) throw new Error(`Pushed commit ${after} is not available locally; check out with full history (fetch-depth: 0)`);

  const selection = selectNewCommits(repoRoot, { branch, before, after, defaultBranch, exec });
  const facts = loadCommitFacts(repoRoot, selection.shas, exec);
  const warnings = [];
  for (const fact of facts) {
    const verdict = validateCommitMessage(fact.message);
    if (!verdict.ok) warnings.push({ sha: fact.sha, subject: verdict.subject, problems: verdict.problems });
  }
  const result = facts.length
    ? withRetry(() => recordCommitsProgress({
      cwd: repoRoot, branch, commits: facts, now, exec, homeDir, defaultBranch, branchOwnedShas: selection.owned ?? [],
    }))
    : { recorded: [], alreadyRecorded: [], rejected: [] };
  return {
    repoRoot, branch, mode: selection.mode, candidates: selection.shas.length,
    recorded: result.recorded.map((c) => c.sha), alreadyRecorded: result.alreadyRecorded.map((c) => c.sha),
    rejected: result.rejected, warnings, ignored: result.ignored ?? false, reason: result.reason,
    ...(selection.recovery ? { recovery: selection.recovery } : {}),
  };
}

/** Ingest a pull_request event payload for a same-repository development branch. */
export function ingestPullRequest({
  cwd = process.cwd(), payload, now = new Date(), exec = execFileSync, homeDir = os.homedir(), defaultBranch = null,
} = {}) {
  const repoRoot = resolveRepoRoot(cwd, exec);
  if (!loadRepoConfig(repoRoot, exec)) return { repoRoot, skipped: true, reason: 'DocFlow is not enabled in this repository' };
  const pr = payload?.pull_request;
  if (!pr?.head?.ref) throw new Error('Event payload has no pull_request.head.ref');
  if (pr.head.repo?.full_name && pr.base?.repo?.full_name && pr.head.repo.full_name !== pr.base.repo.full_name) {
    return { repoRoot, skipped: true, reason: 'Fork pull requests are not ingested' };
  }
  const branch = normalizeBranchName(pr.head.ref);
  const base = defaultBranch || payload?.repository?.default_branch || null;
  if (!isDevelopmentBranch(branch, { repoRoot, exec, defaultBranch: base })) {
    return { repoRoot, skipped: true, reason: `Branch '${branch}' is not a development branch` };
  }

  let push = { recorded: [], alreadyRecorded: [], warnings: [] };
  if (pr.head.sha && commitExists(repoRoot, pr.head.sha, exec)) {
    push = ingestPush({
      cwd: repoRoot, ref: `refs/heads/${branch}`, before: payload.before ?? null, after: pr.head.sha,
      defaultBranch: base, now, exec, homeDir,
    });
  }
  const merged = Boolean(pr.merged);
  const event = withRetry(() => recordPullRequestEvent({
    cwd: repoRoot, branch,
    pr: {
      number: pr.number, state: pr.state === 'closed' ? 'closed' : 'open', title: pr.title ?? null, url: pr.html_url ?? null,
      merged, mergedAt: pr.merged_at ?? null, closedAt: pr.closed_at ?? null, updatedAt: pr.updated_at ?? null,
    },
    action: typeof payload?.action === 'string' ? payload.action : null,
    now, exec, homeDir, defaultBranch: base,
  }));
  return {
    repoRoot, branch, prNumber: pr.number, merged,
    recorded: push.recorded ?? [], alreadyRecorded: push.alreadyRecorded ?? [], warnings: push.warnings ?? [],
    unitId: event.task?.id ?? null, ignored: event.ignored ?? false, reason: event.reason,
    ...(push.recovery ? { recovery: push.recovery } : {}),
  };
}
