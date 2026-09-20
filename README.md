# DocFlow

DocFlow is a cross-agent development-documentation workflow.

It solves one narrow v1 problem: **keep repository-owned project progress current automatically, and make it visible in Obsidian without creating a second source of truth.**

## v1 model

Each enabled repository keeps DocFlow state under `.docflow/`.

A version/task records:

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

This creates:

```text
.docflow/
  config.json     repo opt-in + Obsidian note name
  project.md      user/Worker-owned Project definition and principles
  state.json      canonical version/task progress
  runtime.json    technical checkpoint state
```

DocFlow never chooses the next product version. Use the version/task ID already defined by the user or repository.

## Local Obsidian configuration

Machine-local paths stay outside public repositories:

```bash
node /path/to/DocFlow/bin/docflow.js configure \
  --vault "/Users/jack/Downloads/PhD" \
  --project-folder "02 Projects"
```

A repository only stores its note name, for example `project - spinlab.md`.

DocFlow updates exactly one block:

```text
<!-- DOCFLOW:START -->
...
<!-- DOCFLOW:END -->
```

Everything outside that block is preserved. If the note does not exist, DocFlow creates a standard Markdown project note.

## Task example

```bash
node /path/to/DocFlow/bin/docflow.js start \
  --id 5.3.8 \
  --title "AFM plotting" \
  --task "Add AFM plotting to SpinLab" \
  --current "First AFM version can plot data" \
  --next "Adjust the UI"

node /path/to/DocFlow/bin/docflow.js begin

# ...do the work and verification...

node /path/to/DocFlow/bin/docflow.js checkpoint \
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
