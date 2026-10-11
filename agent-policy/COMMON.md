# DocFlow Worker Contract

DocFlow keeps the project's progress current automatically and shows it in the user's Obsidian note. The user never edits or reads DocFlow files: you record progress for them.

At the start of a non-trivial development round in a git repository, run:
   `{{DOCFLOW_CLI}} status --cwd <repo> --json`
If it reports `enabled: false`, DocFlow is not enabled for the repository and no further DocFlow action is required.

## Progress comes from Git

- Work on a development branch (one branch = one progress unit; never on `main`/`master`).
- Write a meaningful first line for every commit. It becomes the human-facing progress entry in Obsidian. State what changed for the project, e.g. “Add retry to the upload step”; never “wip”, “update”, “changes”.
- The repository's `commit-msg` hook validates the subject. If a commit is rejected, rewrite the first line and commit again. Do not bypass the hook with `--no-verify`.
- Push as usual. A GitHub Action records every new commit once; the user's Mac later projects it into Obsidian. Do not hand-write progress and do not push `docflow-state` yourself.

## Recording “Next” (what happens next)

Obsidian shows a **Next** line per branch, and only you or the user can supply it; it is never inferred from commits.

- At the end of every meaningful round (after pushing), run:
  `{{DOCFLOW_CLI}} next --cwd <repo> "<one short sentence: the concrete next step>"`
- Whenever the user tells you what they want to do next, record their intent the same way, in their own words.
- When the branch is finished and nothing is pending: `{{DOCFLOW_CLI}} next --cwd <repo> --clear`.
- Write for a human reading a project note: plain language, no file/function names, one sentence.
- If it reports that no progress is recorded yet, the GitHub Action has not processed the push yet; retry in a minute or two, and tell the user if it still fails.
- Do not call a model to summarize progress.

DocFlow never force-pushes. If it reports a remote divergence/push failure, surface it and retry rather than forcing anything.
