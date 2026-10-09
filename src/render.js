// Presentation of commit-native units. Pure functions: they read a validated task and
// return Markdown lines. Capture (core.js / ingest.js) never depends on this file, so
// the Obsidian format can change without touching what is recorded.

function shortSha(sha) {
  return String(sha).slice(0, 7);
}

function day(value) {
  const match = /^(\d{4}-\d{2}-\d{2})T/.exec(String(value ?? '').trim());
  return match ? match[1] : String(value ?? '').trim();
}

// Commit subjects are arbitrary text. Neutralize HTML comment openers so a subject can never
// forge or close a DocFlow managed-block marker (which would wedge every later sync).
function safeText(text) {
  return String(text).replaceAll('<!--', '&lt;!--').replaceAll('-->', '--&gt;');
}

function entry(commit) {
  return `${safeText(commit.message)} (\`${shortSha(commit.sha)}\`${commit.timestamp ? `, ${day(commit.timestamp)}` : ''})`;
}

/**
 * Current / Next / History for a unit that has recorded commits. Identity is the commit
 * SHA: each distinct SHA is one line, so identical subjects never collapse. Only the first
 * line (already the stored `message`) is shown; bodies are never stored or projected.
 * Legacy v1 history lines that are not commit-derived are kept above the commit lines.
 * Next is only ever what a person wrote, never inferred from a commit.
 */
export function commitUnitSections(task) {
  const commits = task.commits || [];
  const newest = commits.at(-1);
  const commitSubjects = new Set(commits.map((c) => c.message));
  const legacy = (task.history || []).filter((h) => !commitSubjects.has(h.text)).map((h) => safeText(h.text));
  return {
    current: entry(newest),
    next: task.next || '-',
    history: [...legacy, ...commits.slice(0, -1).map(entry)],
  };
}
