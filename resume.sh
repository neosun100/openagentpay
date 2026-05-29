#!/usr/bin/env bash
# resume.sh — one-tap "load savepoint" for OpenAgentPay
#
# What this does:
#   1. cd into the project root (so CLAUDE.md auto-loads)
#   2. Re-enter the most recent Claude Code session for this project
#      (continues from the same context — same as `claude --continue`)
#
# Why we need this:
#   Claude Code persists every session as a JSONL file under
#   ~/.claude/projects/<encoded-path>/<session-id>.jsonl. The
#   `claude --continue` flag re-attaches to the most recent one.
#   This script just makes that one-keystroke for this specific repo.
#
# Usage:
#   bash resume.sh         # continue most recent session
#   bash resume.sh pick    # show the picker (claude --resume)
#   bash resume.sh fresh   # start a fresh session (CLAUDE.md still auto-loads)
#
# License: Apache-2.0

set -e
cd "$(dirname "$0")"

PROJECT_DIR="$(pwd)"
ENCODED_PATH=$(echo "$PROJECT_DIR" | sed 's|/|-|g')
SESSIONS_DIR="$HOME/.claude/projects/$ENCODED_PATH"

mode="${1:-continue}"

case "$mode" in
  continue|c)
    if [ ! -d "$SESSIONS_DIR" ] || [ -z "$(ls -A "$SESSIONS_DIR"/*.jsonl 2>/dev/null)" ]; then
      echo "▸ No prior sessions found in $SESSIONS_DIR"
      echo "▸ Starting a fresh session — CLAUDE.md will auto-load."
      exec claude
    fi
    LATEST=$(ls -t "$SESSIONS_DIR"/*.jsonl 2>/dev/null | head -1)
    SIZE=$(du -h "$LATEST" | cut -f1)
    SESSION_ID=$(basename "$LATEST" .jsonl)
    echo "▸ Resuming most recent session"
    echo "  id:   ${SESSION_ID:0:8}…"
    echo "  size: $SIZE"
    echo "  cwd:  $PROJECT_DIR"
    echo ""
    exec claude --continue
    ;;

  pick|resume|r)
    echo "▸ Opening session picker (claude --resume)…"
    echo "  cwd: $PROJECT_DIR"
    echo ""
    exec claude --resume
    ;;

  fresh|new|n)
    echo "▸ Starting a fresh session (CLAUDE.md will auto-load STATE.md instructions)"
    echo "  cwd: $PROJECT_DIR"
    echo ""
    exec claude
    ;;

  list|ls)
    echo "▸ Available sessions for $PROJECT_DIR"
    echo ""
    if [ ! -d "$SESSIONS_DIR" ]; then
      echo "  (none yet)"
      exit 0
    fi
    ls -lt "$SESSIONS_DIR"/*.jsonl 2>/dev/null | while read -r line; do
      file=$(echo "$line" | awk '{print $NF}')
      size=$(echo "$line" | awk '{print $5}')
      mtime=$(echo "$line" | awk '{print $6, $7, $8}')
      id=$(basename "$file" .jsonl)
      printf "  %s  %8s bytes  %s\n" "${id:0:8}" "$size" "$mtime"
    done
    ;;

  help|-h|--help)
    cat <<EOF
resume.sh — OpenAgentPay savepoint launcher

USAGE:
  bash resume.sh               # continue most recent session (default)
  bash resume.sh continue      # same as above
  bash resume.sh pick          # show session picker
  bash resume.sh fresh         # start a fresh session
  bash resume.sh list          # list all saved sessions for this project
  bash resume.sh help          # this message

NOTES:
  - All sessions auto-persist as JSONL under
    ~/.claude/projects/<encoded-path>/
  - Even fresh sessions auto-load CLAUDE.md, which then makes Claude
    read docs/STATE.md to recover project context.
EOF
    ;;

  *)
    echo "Unknown mode: $mode"
    echo "Run 'bash resume.sh help' for usage."
    exit 2
    ;;
esac
