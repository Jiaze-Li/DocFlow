import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUBJECT_LENGTH, formatValidationFailure, subjectOf, validateCommitMessage } from '../src/validator.js';

const codes = (message) => validateCommitMessage(message).problems.map((p) => p.code);

test('accepts specific subjects, with or without bodies and conventional prefixes', () => {
  for (const m of [
    'Add retry to the upload step',
    'fix(core): handle null token',
    'Add CI',
    'Fix typo',
    'Add retry to uploads\n\nBody with detail.\nMore detail.',
    '  Indented subject is trimmed fine  ',
    '日本語のコミットメッセージ',
  ]) assert.deepEqual(codes(m), [], m);
});

test('rejects empty, whitespace-only and comment-only messages', () => {
  for (const m of ['', '   \n\n', '# please enter a message\n# more help', null, undefined]) {
    assert.deepEqual(codes(m), ['empty']);
  }
});

test('rejects placeholder-only subjects, including conventional-prefix placeholders', () => {
  for (const m of ['wip', 'WIP', 'update', 'Updates.', 'changes', 'fix', 'fix: update', 'chore: wip', 'misc', 'asdf', 'test!']) {
    assert.ok(codes(m).includes('placeholder'), m);
  }
  assert.ok(!codes('fix: update retry budget for uploads').includes('placeholder'));
});

test('enforces structural limits at the boundaries', () => {
  assert.deepEqual(codes('a'.repeat(MAX_SUBJECT_LENGTH)), []);
  assert.deepEqual(codes('a'.repeat(MAX_SUBJECT_LENGTH + 1)), ['subject-too-long']);
  assert.deepEqual(codes('abcdef'), []);
  assert.ok(codes('abcde').includes('subject-too-short'));
  assert.deepEqual(codes('Add feature\nbody without blank line'), ['no-blank-after-subject']);
  assert.deepEqual(codes('\nSubject after a blank first line'), ['leading-blank']);
  assert.ok(codes('!!!!!!!!').includes('no-words'));
});

test('ignores git comment lines and normalizes CRLF; first non-empty line is the subject', () => {
  assert.equal(subjectOf('# comment\r\nAdd real change\r\n\r\nbody'), 'Add real change');
  assert.deepEqual(codes('Add real change\n\n# Please enter the commit message\n# lines starting with #'), []);
});

test('git-generated and fixup subjects are accepted', () => {
  for (const m of ['Merge branch \'x\' into y', 'Merge pull request #4 from a/b', 'Revert "Add thing"', 'fixup! Add thing', 'squash! Add thing']) {
    assert.equal(validateCommitMessage(m).ok, true, m);
  }
});

test('failure output says why, what to change and how to retry, and never proposes a rewrite', () => {
  const text = formatValidationFailure(validateCommitMessage('wip'));
  assert.match(text, /Why:/);
  assert.match(text, /Change:/);
  assert.match(text, /Retry:/);
  assert.match(text, /does not generate a replacement/);
});
