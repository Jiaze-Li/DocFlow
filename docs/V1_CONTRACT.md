# DocFlow v1 contract

## Goal

Provide one cross-agent development-documentation workflow that keeps repository-owned version/task progress current and exposes it read-only in Obsidian.

## Ownership

- The repository/Worker owns business meaning, task/version IDs, Project definition, Project principles, Current, and Next.
- DocFlow owns the deterministic lifecycle: checkpoint timing, Current → History append, status fields, persistence, and Obsidian projection.
- Obsidian is not a source of truth in v1.

## Progress model

Each repository-defined development unit records:

- Task
- Started
- Status: In progress / Waiting / Paused / Completed / Abandoned
- Current
- Next
- History
- Completed, when terminal
- Outcome, when terminal

History records past facts. Current records the present fact. Next records current intent. Old Next is never mechanically promoted to Current.

A Project may contain multiple simultaneously active units. Unit IDs are opaque to DocFlow: they may be versions such as `v5.3.8` or other repository-defined IDs such as `afm-workflow`.

## Checkpoint

A checkpoint occurs after meaningful work and required validation/review, immediately before the Worker delivers that round to the user. Internal edits/commits/tests do not each create checkpoints.

DocFlow must detect a pending delivery deterministically when a round is open or repository work changed after the last checkpoint. The gate does not call a model.

## Obsidian v1

Global machine config defines the Vault and project folder. Each enabled worktree/repository declares its target Project note. The note contains one outer `DOCFLOW:START/END` container and independently replaceable `DOCFLOW:UNIT:<id>:START/END` blocks. A checkpoint updates only the current unit block and preserves every other unit byte-for-byte. This permits multiple worktrees to project independent units into the same Project note without overwriting one another. Project-note read/modify/write is serialized by a machine-local DocFlow lock so concurrent worktree checkpoints cannot lose one another's updates. Legacy whole-project task sections from the earlier v1 projection are migrated in place to unit blocks on first sync, rather than duplicated. Missing notes may be created as standard Markdown project notes.

## Cost

DocFlow does not start a reviewer/summarizer model. The Worker supplies only short Current/Next/Status facts already known from the work it just completed.

## Deferred

Full technical-doc classification, Roadmap management, bidirectional Obsidian editing, automatic version selection, multi-user collaboration, and semantic repository understanding are outside v1.
