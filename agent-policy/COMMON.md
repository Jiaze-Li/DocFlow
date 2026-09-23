# DocFlow Worker Contract

DocFlow is the shared development-documentation workflow. The current repository owns its business meaning; DocFlow only standardizes progress recording.

At the start of a non-trivial development round in a git repository, run:
   `{{DOCFLOW_CLI}} status --cwd <repo> --json`
If it reports `enabled: false`, DocFlow is not enabled for that repository and no further DocFlow action is required.

When DocFlow is enabled:

1. Identify the repository-defined development unit for this round. Its ID may be a version (for example `v5.3.8`) or another repo-defined task ID (for example `afm-workflow`). Never invent or normalize IDs for DocFlow.
2. Before a non-trivial development round, run:
   `{{DOCFLOW_CLI}} begin --cwd <repo> --id <unit-id>`
3. Do the work normally. Multiple units in the same Project may remain `In progress` at the same time.
4. Run required tests/review first. If ReviewLoop is used, a meaningful `PHASE_PASS` or `PASS` is a good checkpoint boundary.
5. Before telling the user that a meaningful round is delivered, run one DocFlow checkpoint for the same unit with concise human-facing facts:
   - `current`: what actually changed for the user/project;
   - `next`: the current plan, which may differ from the previous Next;
   - `status`: lifecycle state when it changed.
6. Run `{{DOCFLOW_CLI}} gate --cwd <repo> --json`. Do not claim delivery while it reports `PENDING`.

Writing rules:
- Use short functional language: “AFM first version can plot data”, not file/function/commit details.
- History is factual and append-only. Current is the present fact. Next is intent, not a promise.
- Do not checkpoint every commit, test, or internal edit—only meaningful delivery/state changes.
- Do not change Project definition/principles unless the user or task asks for it.
- Do not invoke a separate LLM just to summarize progress.
- `Completed` and `Abandoned` are terminal in v1; start a new task/version instead of silently reopening one.

Durable project/unit state lives on the repository's reserved `docflow-state` branch; per-worktree runtime is machine-local Git metadata. Do not create or maintain business progress in an untracked worktree `.docflow` directory.
When the repository has an `origin` remote, DocFlow automatically refreshes and safely pushes `docflow-state` during durable writes. Do not add a separate manual state-push step; if DocFlow reports a remote divergence/push failure, surface it and reconcile/retry rather than force-pushing.
