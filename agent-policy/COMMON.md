# DocFlow Worker Contract

DocFlow is the shared development-documentation workflow. The current repository owns its business meaning; DocFlow only standardizes progress recording.

When a repository contains `.docflow/config.json`:

1. Before a non-trivial development round, run:
   `{{DOCFLOW_CLI}} begin --cwd <repo>`
2. Do the work normally. Use the repository's own version/task ID. Never invent the next product version merely because DocFlow needs an ID.
3. Run required tests/review first. If ReviewLoop is used, a meaningful `PHASE_PASS` or `PASS` is a good checkpoint boundary.
4. Before telling the user that a meaningful round is delivered, run one DocFlow checkpoint with concise human-facing facts:
   - `current`: what actually changed for the user/project;
   - `next`: the current plan, which may differ from the previous Next;
   - `status`: lifecycle state when it changed.
5. Run `{{DOCFLOW_CLI}} gate --cwd <repo> --json`. Do not claim delivery while it reports `PENDING`.

Writing rules:
- Use short functional language: “AFM first version can plot data”, not file/function/commit details.
- History is factual and append-only. Current is the present fact. Next is intent, not a promise.
- Do not checkpoint every commit, test, or internal edit—only meaningful delivery/state changes.
- Do not change Project definition/principles unless the user or task asks for it.
- Do not invoke a separate LLM just to summarize progress.
- `Completed` and `Abandoned` are terminal in v1; start a new task/version instead of silently reopening one.

If DocFlow is not enabled in the repository, do nothing.
