# DocFlow

DocFlow is a cross-agent development-documentation workflow.

It solves one narrow v1 problem: **keep repository-owned project progress current automatically, and make it visible in Obsidian without creating a second source of truth.**

## v2: commit-native progress (recommended)

A development commit is the progress fact. No `begin` / `checkpoint` / `gate` call is needed for correctness.

```text
git commit  ->  commit-msg hook validates the subject (deterministic, no model)
git push    ->  GitHub Action ingests every new commit onto docflow-state (once per SHA)
Mac         ->  `docflow sync` projects docflow-state into the Obsidian note
```

- One development branch = one unit. `main`, `master`, the repository default branch and `docflow-state` are never units.
- One distinct commit SHA = one progress event (repository-wide replay is idempotent). Two commits with identical subjects are two events.
- The commit's **first non-empty line** is the progress text. Bodies are Git detail and are never promoted; `Next` is never inferred.
- PR opened → PR metadata attaches to the branch unit; PR merged → `Completed` / `Merged`; closed unmerged → `Abandoned`. Deleting a branch never deletes progress.
- No historical backfill: only commits first exposed by a push after activation are ingested. Branches that existed at activation are forward-only; a missed Action run is reconciled by the next push for that branch.
- GitHub validates subjects again; an invalid one produces a workflow warning/summary but is still ingested. History is never rewritten and `docflow-state` is only ever fast-forwarded.

### Enable in a repository

```bash
node /path/to/DocFlow/bin/docflow.js init --project <name> --note "project - <name>.md"
node /path/to/DocFlow/bin/docflow.js deploy --json
```

`deploy` is opt-in. It installs the local commit validator, activates the existing
durable state, and places **one stable workflow entrypoint** on the remote default
branch and every existing development branch. Each entrypoint invokes
`Jiaze-Li/DocFlow/action@main`, so future capture/PR logic updates are made
centrally in DocFlow instead of copied into every repository.

Deployment uses temporary Git worktrees and ordinary fast-forward pushes. It
never stages your working files, force-pushes, rewrites branch history, or
overwrites another project's workflow. A checked-out branch must be clean and
at the same tip as `origin`; successful deployment fast-forwards that checkout.
If a branch is dirty/diverged/protected or its workflow is unrelated, `deploy`
reports it under `blocked` and exits nonzero. Resolve the blocker (or use
a PR for a protected branch), then rerun; already-deployed branches are no-ops.
The `deployed`, `unchanged`, and `blocked` fields show what actually happened.
Deployment only updates **remote-tracking and repository state**, not other repos.
It does not run or guarantee future GitHub Actions jobs: the first real push
must confirm ingestion in GitHub Actions.

For an older repository, you can run `deploy` directly if `docflow-state`
already exists. The activation snapshot only anchors current branch tips: it
**does not backfill** earlier commits. `docflow deploy` is safe to rerun.

The existing `setup-repo` command remains for manual setup and offline workflows:

```bash
node /path/to/DocFlow/bin/docflow.js setup-repo
git add .github/workflows/docflow.yml && git commit -m "Enable DocFlow commit-native progress" && git push
node /path/to/DocFlow/bin/docflow.js doctor
```

Both commands refuse to overwrite an unrelated `commit-msg` hook or workflow.
The workflow needs only `contents: write` and never uses
`pull_request_target`; `--action-ref` can override the action revision.

The commit subject rules (`docflow validate-message --message "..."`): non-empty, 6–100 characters, not a placeholder (`wip`, `update`, `changes`, …), a blank line before any body. Merge/revert/fixup subjects pass.

Legacy v1 commands below keep working for repositories that have not activated commit-native progress.

## v1 model

Each enabled repository keeps durable DocFlow state on a reserved Git branch named `docflow-state`. Business branches/worktrees do not own the long-lived progress record.

A development unit records:

- Task
- Started
- Status
- Current
- Next
- History
- Completed / Outcome when terminal

The rule is simple:

> History records past facts. Current records the present fact. Next records current intent.

`Next` is not mechanically promoted to `Current`; the Worker records what actually happened.

## Checkpoint workflow

```text
meaningful work begins
  -> docflow begin
  -> implementation / tests / review
  -> docflow checkpoint (Current + Next + Status)
  -> old Current appends to History
  -> docflow-state safely pushes to origin when configured
  -> Obsidian managed block refreshes
  -> docflow gate == READY
  -> Worker reports the round to the user
```

DocFlow does not call a summarizer/reviewer model. The current Worker supplies a few short human-facing facts it already knows.

## Repository setup

From the target repository:

```bash
node /path/to/DocFlow/bin/docflow.js init \
  --project SpinLab \
  --note "project - spinlab.md"
```

This creates/updates the reserved state branch:

```text
docflow-state
└── .docflow/
    ├── config.json
    ├── project.md
    └── units/
        ├── afm-workflow.json
        └── v5.3.8.json
```

Each worktree keeps only ephemeral runtime under its own Git metadata (for example `.git/worktrees/<name>/docflow/runtime.json`). Deleting a feature worktree or branch therefore does not delete its DocFlow History.

When an `origin` remote exists, every durable-state write refreshes `origin/docflow-state` first and then pushes the new state commit automatically. Pushes are ordinary fast-forward pushes only: DocFlow never force-pushes the state branch. If the remote advances concurrently or diverges, the write fails closed and must be retried/reconciled instead of overwriting remote history. Repositories without an `origin` continue to work with local-only durable state.

Legacy worktree-local `.docflow/state.json` data from the earlier v1 implementation is migrated into `docflow-state` by running `docflow init` again in that worktree; the old worktree-local directory is removed only after a successful migration.

DocFlow never chooses or normalizes business IDs. A development unit may use an existing version ID such as `v5.3.8` or another repository-defined ID such as `afm-workflow`. Multiple units may be `In progress` simultaneously.

## Local Obsidian configuration

Machine-local paths stay outside public repositories:

```bash
node /path/to/DocFlow/bin/docflow.js configure \
  --vault "/Users/jack/Downloads/PhD" \
  --project-folder "02 Projects"
```

A repository only stores its note name, for example `project - spinlab.md`.

DocFlow keeps one Project container and one independently replaceable block per development unit:

```text
<!-- DOCFLOW:START -->
<!-- Generated by DocFlow. Edit the repository source, not this block. -->

<!-- DOCFLOW:UNIT:afm-workflow:START -->
## afm-workflow · AFM Plotting Workflow
...
<!-- DOCFLOW:UNIT:afm-workflow:END -->

<!-- DOCFLOW:UNIT:v5.3.8:START -->
## v5.3.8 · 3ω Scaling vs Angle
...
<!-- DOCFLOW:UNIT:v5.3.8:END -->
<!-- DOCFLOW:END -->
```

A checkpoint first persists its unit on `docflow-state`, then patches only that unit's Obsidian block. Other units and all manual content outside the outer DocFlow block are preserved. Separate worktrees can therefore share one Project note without owning or overwriting one another's durable state.

Same-unit writes use an optimistic revision precondition. If another worktree changes that unit after it was read, the stale checkpoint/start is rejected and must reload before retrying; DocFlow never auto-merges competing Current/Next/History facts.

### Recovery boundaries

- **Activation anchors.** `setup-repo` records each pre-existing branch's tip SHA at activation time (`tips` in the activation record). If the first post-activation run for such a branch is lost, the next push or PR event recovers everything after that anchor; pre-activation history is never backfilled. Activation records written before `tips` existed keep the old forward-only behaviour and report `recovery.anchored: false` (also a GitHub warning annotation) because a lost earlier run cannot be reconstructed after the fact. The same is reported when the anchor is no longer an ancestor of the pushed tip (rewritten history).
- **Delayed first delivery after a merge.** If the first event for a branch is processed after it was merged with a merge commit, the branch's own commits are recovered from the merge's second parent (`tip --not M^1`), never from base history. Fast-forward merges and branches cut from base carry no such evidence and record nothing.
- **Reopened PRs.** Only a `reopened` event whose `updated_at` is not older than the recorded closure restores an Abandoned unit to In progress (clearing the closure). Merged units are terminal, and stale `opened` / `synchronize` / `closed` events (older than the last applied PR event) are ignored.

### Commit-derived projection and automatic catch-up

For commit-native units the projection comes from the commit ledger, not from text: **every distinct SHA is one entry** (two commits with the same subject stay two entries), only the first line of each message is shown (with its short SHA and date), the newest commit is **Current**, earlier ones are **History** in push order, and **Next** is `-` unless a person wrote one. Units without commits (v1) render as before. Presentation lives in `src/render.js` and can change without touching capture.

Obsidian is refreshed with no model and no resident daemon:

```bash
docflow sync --refresh          # fetch the newest docflow-state, then project this repo
docflow catch-up                # same for every repository DocFlow knows about
docflow install-sync-agent      # writes ~/Library/LaunchAgents/com.docflow.catchup.plist (runs catch-up at load and every 10 min)
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.docflow.catchup.plist   # explicit opt-in to start it
docflow uninstall-sync-agent
```

`catch-up` is idempotent: a Mac that was offline simply picks up all missed commits on its next run, with no loss or duplication. If origin is unreachable it still projects the newest durable state already present locally. A repository that fails (deleted path, malformed managed block) is reported without blocking the others, and a malformed managed block is never rewritten. Manual `docflow sync` always works. `docflow doctor` reports whether the agent is current, stale or missing.

## Task example

```bash
node /path/to/DocFlow/bin/docflow.js start \
  --id afm-workflow \
  --title "AFM Plotting Workflow" \
  --task "Add AFM plotting to SpinLab" \
  --current "First AFM version can plot data" \
  --next "Adjust the UI"

node /path/to/DocFlow/bin/docflow.js begin --id afm-workflow

# ...do the work and verification...

node /path/to/DocFlow/bin/docflow.js checkpoint \
  --id afm-workflow \
  --current "AFM UI first revision is complete" \
  --next "Add selectable flatten"

node /path/to/DocFlow/bin/docflow.js gate --json
```

## Global Worker setup

DocFlow installs one shared Worker policy for the supported coding agents present on the machine:

```bash
npm run setup -- \
  --vault "/Users/jack/Downloads/PhD" \
  --project-folder "02 Projects"
```

Supported v1 frontends:

- Claude
- Codex
- AGY

The policy is identical across frontends and requires a DocFlow checkpoint before a meaningful delivery is reported.

## Status lifecycle

- `In progress`
- `Waiting`
- `Paused`
- `Completed`
- `Abandoned`

`Completed` and `Abandoned` are terminal in v1. Merge/release result is stored separately as `Outcome`, e.g. `Merged`.

## Scope

v1 intentionally does **not** do full technical-document management, Roadmap editing, bidirectional Obsidian editing, automatic version selection, or semantic repository understanding.

See [`docs/V1_CONTRACT.md`](docs/V1_CONTRACT.md).
