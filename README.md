# DocFlow

DocFlow keeps a project's progress current automatically and shows it in Obsidian, read-only, without a second source of truth. No model is called; everything is deterministic Git.

## Quick start (any computer)

```bash
git clone https://github.com/Jiaze-Li/DocFlow.git ~/.docflow/app
bash ~/.docflow/app/scripts/bootstrap.sh --vault "/path/to/ObsidianVault" --project-folder "02 Projects"
```

The same script updates an existing install (`docflow update` runs it): it pulls the newest DocFlow, reinstalls the agent policy for Claude / Codex / AGY, refreshes Obsidian and, on macOS, enables the 10-minute auto-sync. Rerun it any time.

Then, in each project: `docflow init --project <name> --note "project - <name>.md"` and `docflow deploy`.

## Recording "Next"

Obsidian shows a **Next** line per branch. It is never guessed from commits. Agents record it for you at the end of each round (the installed policy tells them to), or you tell the agent what you want to do next and it records that:

```bash
docflow next "Wire up dark mode"      # current branch
docflow next --clear                  # nothing pending
```

## Stable releases

Projects reference `Jiaze-Li/DocFlow/action@v2`, a tag that only moves when you run **Actions → Release stable tag → Run workflow** (it runs the tests first). Work on `main` therefore never changes deployed projects by accident.

## How it works

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

## Enable in a repository

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

Legacy v1 commands are documented in [`docs/LEGACY_V1.md`](docs/LEGACY_V1.md).


## Recovery boundaries

- **Activation anchors.** `setup-repo` records each pre-existing branch's tip SHA at activation time (`tips` in the activation record). If the first post-activation run for such a branch is lost, the next push or PR event recovers everything after that anchor; pre-activation history is never backfilled. Activation records written before `tips` existed keep the old forward-only behaviour and report `recovery.anchored: false` (also a GitHub warning annotation) because a lost earlier run cannot be reconstructed after the fact. The same is reported when the anchor is no longer an ancestor of the pushed tip (rewritten history).
- **Delayed first delivery after a merge.** If the first event for a branch is processed after it was merged with a merge commit, the branch's own commits are recovered from the merge's second parent (`tip --not M^1`), never from base history. Fast-forward merges and branches cut from base carry no such evidence and record nothing.
- **Reopened PRs.** Only a `reopened` event whose `updated_at` is not older than the recorded closure restores an Abandoned unit to In progress (clearing the closure). Merged units are terminal, and stale `opened` / `synchronize` / `closed` events (older than the last applied PR event) are ignored.

## Obsidian projection and automatic catch-up

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

## Scope

DocFlow intentionally does **not** do full technical-document management, Roadmap editing, bidirectional Obsidian editing, or semantic repository understanding. See [`docs/V1_CONTRACT.md`](docs/V1_CONTRACT.md) for the original storage contract.
