// Deterministic commit-message validator. It enforces objective minimum rules only:
// no semantic understanding, no model call. The same function backs the local
// commit-msg hook, GitHub ingestion and tests.

export const MAX_SUBJECT_LENGTH = 100;
export const MIN_SUBJECT_LENGTH = 6;

const PLACEHOLDERS = new Set([
  'wip', 'work in progress', 'update', 'updates', 'updated', 'change', 'changes', 'changed',
  'fix', 'fixes', 'fixed', 'misc', 'stuff', 'test', 'tests', 'temp', 'tmp', 'asdf', 'foo', 'bar',
  'commit', 'save', 'saved', 'progress', 'todo', 'minor', 'cleanup', 'refactor', 'edit', 'edits',
  'initial', 'initial commit', 'first commit', 'checkpoint', 'untitled', 'draft', 'done', 'ok',
]);

// Messages Git itself generates are not authored progress statements.
const GIT_GENERATED = /^(Merge (branch|pull request|remote-tracking branch|tag)\b|Revert ")/;
const FIXUP = /^(fixup|squash|amend)! /;

export function stripGitComments(message) {
  return String(message ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .filter((line) => !line.startsWith('#'))
    .join('\n');
}

export function subjectOf(message) {
  return stripGitComments(message).split('\n').map((l) => l.trim()).find(Boolean) || '';
}

function placeholderKeys(subject) {
  const lower = subject.toLowerCase();
  const trim = (v) => v.replace(/[\s.!:_-]+$/g, '').trim();
  const withoutType = lower.replace(/^[a-z]+(\([^)]*\))?!?:\s*/, '');
  return [trim(lower), trim(withoutType)];
}

/**
 * @returns {{ ok: boolean, subject: string, skipped?: string, problems: Array<{code:string, reason:string, fix:string}> }}
 */
export function validateCommitMessage(message) {
  const lines = stripGitComments(message).split('\n');
  const index = lines.findIndex((l) => l.trim());
  const subject = index < 0 ? '' : lines[index].trim();
  const problems = [];

  if (!subject) {
    problems.push({
      code: 'empty',
      reason: 'The commit message is empty.',
      fix: 'Start the message with one line stating what this commit changes for the project.',
    });
    return { ok: false, subject, problems };
  }

  if (GIT_GENERATED.test(subject) || FIXUP.test(subject)) {
    return { ok: true, subject, skipped: 'git-generated', problems };
  }

  if (index > 0) {
    problems.push({
      code: 'leading-blank',
      reason: 'The first line of the message is blank, so the subject is not on line 1.',
      fix: 'Put the subject on the very first line.',
    });
  }
  if (subject.length > MAX_SUBJECT_LENGTH) {
    problems.push({
      code: 'subject-too-long',
      reason: `The subject is ${subject.length} characters (limit ${MAX_SUBJECT_LENGTH}).`,
      fix: `Shorten the first line to at most ${MAX_SUBJECT_LENGTH} characters; move detail into the body after a blank line.`,
    });
  }
  const next = lines[index + 1];
  if (next !== undefined && next.trim() !== '') {
    problems.push({
      code: 'no-blank-after-subject',
      reason: 'The line after the subject is not blank, so the body runs into the subject.',
      fix: 'Insert one blank line between the subject and the body.',
    });
  }
  if (subject.length < MIN_SUBJECT_LENGTH) {
    problems.push({
      code: 'subject-too-short',
      reason: `The subject "${subject}" is shorter than ${MIN_SUBJECT_LENGTH} characters, too short to state what changed.`,
      fix: 'Rewrite the first line as a short sentence describing the change.',
    });
  }
  const keys = placeholderKeys(subject);
  if (keys.some((k) => PLACEHOLDERS.has(k)) || keys[1] === '') {
    problems.push({
      code: 'placeholder',
      reason: `The subject "${subject}" is a placeholder and does not say what changed.`,
      fix: 'Replace it with a specific statement, e.g. "Add retry to the upload step" instead of "update".',
    });
  }
  if (!/[\p{L}\p{N}]/u.test(subject)) {
    problems.push({
      code: 'no-words',
      reason: 'The subject contains no letters or digits.',
      fix: 'Write the subject as words describing the change.',
    });
  }
  return { ok: problems.length === 0, subject, problems };
}

export function formatValidationFailure(result, { command = 'git commit' } = {}) {
  const lines = ['DocFlow: commit message rejected.', ''];
  lines.push(`  Subject: ${result.subject ? JSON.stringify(result.subject) : '(none)'}`, '');
  for (const problem of result.problems) {
    lines.push(`  - Why: ${problem.reason}`, `    Change: ${problem.fix}`);
  }
  lines.push('', `  Retry: rewrite the first line, then run \`${command}\` again (or \`git commit --amend\` to edit the last message).`);
  lines.push('  DocFlow does not generate a replacement; the commit subject becomes the progress entry shown to the project.');
  return lines.join('\n');
}
