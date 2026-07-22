#!/bin/sh
# Docker entrypoint:
# 1. Fix volume permissions (created as root, need claude ownership)
# 2. Symlink .claude.json into persistent volume

CLAUDE_DIR="/home/claude/.claude"
CLAUDE_JSON="/home/claude/.claude.json"
CLAUDE_JSON_VOL="$CLAUDE_DIR/.claude.json"

# Fix ownership if volume was created as root
if [ -d "$CLAUDE_DIR" ] && [ ! -w "$CLAUDE_DIR" ]; then
  echo "[entrypoint] Fixing volume permissions..."
fi

# Symlink .claude.json into volume so it persists across restarts
if [ -f "$CLAUDE_JSON_VOL" ] && [ ! -f "$CLAUDE_JSON" ]; then
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
elif [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ] && [ -w "$CLAUDE_DIR" ]; then
  cp "$CLAUDE_JSON" "$CLAUDE_JSON_VOL" 2>/dev/null
  rm -f "$CLAUDE_JSON"
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
fi

if [ -n "$MERIDIAN_PLUGINS" ]; then
  SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
  # Warn loudly but still start: a transient npm failure shouldn't take the
  # proxy down, but starting silently without the requested plugins would
  # defeat their purpose (e.g. billing-protection scrubbers).
  if ! node "$SCRIPT_DIR/docker-install-plugins.mjs"; then
    echo "[entrypoint] WARNING: plugin install failed — starting WITHOUT the plugins in MERIDIAN_PLUGINS" >&2
  fi
fi

exec "$@"
