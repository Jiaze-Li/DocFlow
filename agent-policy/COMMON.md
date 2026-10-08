# DocFlow Worker Contract

DocFlow is the shared development-documentation workflow. The current repository owns its business meaning; DocFlow only standardizes progress recording.

At the start of a non-trivial development round in a git repository, run:
   `{{DOCFLOW_CLI}} status --cwd <repo> --json`
If it reports `enabled: false`, DocFlow is not enabled for that repository and no further DocFlow action is required.

## Commit-native repositories (v2, the default for new setups)

If `{{DOCFLOW_CLI}} doctor --cwd <repo>` reports `commit_native: active`, progress is captured from Git itself. **Progress correctness never depends on `begin`, `checkpoint` or `gate`.**

- Work normally on a development branch (one branch = one DocFlow unit).
- Write a meaningful first line for every commit: it becomes the human-facing progress entry. State what changed for the project, e.g. “Add retry to the upload step”; never “wip”, “update”, “changes”.
- The repository's `commit-msg` hook validates the subject. If a commit is rejected, rewrite the first line and commit again. Do not bypass the hook with `--no-verify`.
- Push as usual. A GitHub Action records every new commit once on `docflow-state`; a local sync later projects it into Obsidian. Do not hand-write progress and do not push `docflow-state` yourself.
- `Next` is never inferred from commits. Do not call a model to summarize progress.

## Legacy repositories (v1 checkpoint workflow)

Only when the repository is NOT commit-native:

1. Identify the repository-defined development unit for this round (a version such as `v5.3.8` or another repo-defined task ID). Never invent or normalize IDs.
2. Before a non-trivial round: `{{DOCFLOW_CLI}} begin --cwd <repo> --id <unit-id>`
3. Do the work normally. Multiple units may remain `In progress`.
4. Run required tests/review first.
5. Before reporting a meaningful round as delivered, run one checkpoint for the same unit with concise human-facing `current`, `next` and (when changed) `status`.
6. Run `{{DOCFLOW_CLI}} gate --cwd <repo> --json`. Do not claim delivery while it reports `PENDING`.

Writing rules (legacy checkpoints):
- Use short functional language: “AFM first version can plot data”, not file/function/commit details.
- History is factual and append-only. Current is the present fact. Next is intent, not a promise.
- Do not checkpoint every commit, test, or internal edit—only meaningful delivery/state changes.
- Do not change Project definition/principles unless the user or task asks for it.
- `Completed` and `Abandoned` are terminal; start a new task/version instead of silently reopening one.

Durable project/unit state lives on the repository's reserved `docflow-state` branch; per-worktree runtime is machine-local Git metadata. Do not create or maintain business progress in an untracked worktree `.docflow` directory.
When the repository has an `origin` remote, DocFlow automatically refreshes and safely pushes `docflow-state` during durable writes. Do not add a separate manual state-push step; if DocFlow reports a remote divergence/push failure, surface it and reconcile/retry rather than force-pushing.
