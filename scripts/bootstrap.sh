#!/usr/bin/env bash
# One-step install / update of DocFlow on any computer (macOS or Linux).
#
#   First time:  git clone https://github.com/Jiaze-Li/DocFlow.git ~/.docflow/app && bash ~/.docflow/app/scripts/bootstrap.sh --vault "/path/to/ObsidianVault"
#   Update:      bash ~/.docflow/app/scripts/bootstrap.sh        (also what `docflow update` runs)
#
# Safe to rerun: it pulls the newest DocFlow (fast-forward only), reinstalls the agent
# policy for Claude / Codex / AGY if present, and refreshes every known project's Obsidian note.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VAULT=""
PROJECT_FOLDER="02 Projects"
SYNC_AGENT=1

while [ $# -gt 0 ]; do
  case "$1" in
    --vault) VAULT="$2"; shift 2 ;;
    --project-folder) PROJECT_FOLDER="$2"; shift 2 ;;
    --no-sync-agent) SYNC_AGENT=0; shift ;;
    -h|--help) sed -n '2,9p' "$0"; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done

command -v node >/dev/null || { echo "Node.js 20+ is required (https://nodejs.org)." >&2; exit 1; }
command -v git >/dev/null || { echo "git is required." >&2; exit 1; }
[ "$(node -p 'process.versions.node.split(".")[0]')" -ge 20 ] || { echo "Node.js 20+ is required." >&2; exit 1; }

if [ -d "$APP_DIR/.git" ]; then
  echo "Updating DocFlow in $APP_DIR ..."
  git -C "$APP_DIR" pull --ff-only || echo "Warning: could not update (offline or local changes); continuing with the installed version." >&2
fi

CLI="$APP_DIR/bin/docflow.js"

if [ -n "$VAULT" ]; then
  node "$CLI" configure --vault "$VAULT" --project-folder "$PROJECT_FOLDER" >/dev/null
  echo "Obsidian vault set to: $VAULT/$PROJECT_FOLDER"
fi

node "$CLI" install-global
node "$CLI" catch-up >/dev/null || echo "Note: some projects could not be refreshed yet (see 'docflow doctor')." >&2

if [ "$SYNC_AGENT" = 1 ] && [ "$(uname)" = "Darwin" ]; then
  node "$CLI" install-sync-agent >/dev/null
  PLIST="$HOME/Library/LaunchAgents/com.docflow.catchup.plist"
  launchctl bootout "gui/$(id -u)/com.docflow.catchup" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST" && echo "Automatic Obsidian sync enabled (every 10 minutes)."
elif [ "$SYNC_AGENT" = 1 ]; then
  echo "Automatic sync is macOS-only. On this system, schedule: node \"$CLI\" catch-up  (e.g. cron: */10 * * * *)."
fi

echo
echo "DocFlow is ready. To add a project: cd into it and run:"
echo "  node \"$CLI\" init --project <name> --note \"project - <name>.md\" && node \"$CLI\" deploy"
