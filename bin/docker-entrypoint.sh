#!/bin/sh
# Docker entrypoint:
# 1. Fix volume permissions (created as root, need claude ownership)
# 2. Run claude-code postinstall in the runtime container so the native
#    binary matches the runtime libc (build stage = debian/glibc, runtime =
#    alpine/musl — a glibc binary copied across won't exec). Idempotent.
# 3. Repoint /app/bin/shims/claude at the installed binary (the build-time
#    shim points at the legacy SDK cli.js which no longer ships in 0.2.98+).
# 4. Symlink .claude.json into persistent volume

CLAUDE_DIR="/home/claude/.claude"
CLAUDE_JSON="/home/claude/.claude.json"
CLAUDE_JSON_VOL="$CLAUDE_DIR/.claude.json"

CLAUDE_PKG_BIN="/app/node_modules/@anthropic-ai/claude-code/bin/claude.exe"
CLAUDE_INSTALL="/app/node_modules/@anthropic-ai/claude-code/install.cjs"
SHIM="/app/bin/shims/claude"

# Fix ownership if volume was created as root
if [ -d "$CLAUDE_DIR" ] && [ ! -w "$CLAUDE_DIR" ]; then
  echo "[entrypoint] Fixing volume permissions..."
fi

# Run claude-code's install.cjs if the binary at $CLAUDE_PKG_BIN is still the
# 500-byte stub OR was installed for a different libc (build stage glibc vs.
# runtime musl). The script is idempotent and quick to run; we trigger it
# whenever the binary is missing or below the stub-vs-real threshold, and
# also when running it is cheap enough that we don't bother gating further.
if [ -f "$CLAUDE_INSTALL" ]; then
  pkg_size=$(wc -c < "$CLAUDE_PKG_BIN" 2>/dev/null || echo 0)
  if [ "$pkg_size" -lt 10000 ] || ! "$CLAUDE_PKG_BIN" --version >/dev/null 2>&1; then
    echo "[entrypoint] Running claude-code install.cjs (binary missing / wrong libc)..."
    (cd /app && node "$CLAUDE_INSTALL") || echo "[entrypoint] WARNING: install.cjs failed"
  fi
fi

# Repoint shim at the real binary if available.
if [ -f "$CLAUDE_PKG_BIN" ] && "$CLAUDE_PKG_BIN" --version >/dev/null 2>&1; then
  ln -sf "$CLAUDE_PKG_BIN" "$SHIM"
fi

# Symlink .claude.json into volume so it persists across restarts
if [ -f "$CLAUDE_JSON_VOL" ] && [ ! -f "$CLAUDE_JSON" ]; then
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
elif [ -f "$CLAUDE_JSON" ] && [ ! -L "$CLAUDE_JSON" ] && [ -w "$CLAUDE_DIR" ]; then
  cp "$CLAUDE_JSON" "$CLAUDE_JSON_VOL" 2>/dev/null
  rm -f "$CLAUDE_JSON"
  ln -sf "$CLAUDE_JSON_VOL" "$CLAUDE_JSON"
fi

exec "$@"
