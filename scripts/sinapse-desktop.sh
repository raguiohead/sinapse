#!/usr/bin/env bash
# Launcher used by the desktop shortcut: .desktop entries don't load the shell profile, so nvm must be sourced here.
set -u

REPO="$(cd "$(dirname "$(readlink -f "$0")")/.." && pwd)"
LOG="$HOME/.sinapse/desktop.log"
mkdir -p "$HOME/.sinapse"

export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"

cd "$REPO/apps/desktop" || exit 1
{
  echo "=== $(date '+%F %T') ==="
  npx electron-vite build || echo "build falhou; abrindo o último build"
} >"$LOG" 2>&1

exec npx electron . --no-sandbox >>"$LOG" 2>&1
