#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

SOURCE="$REPO/skill/sinapse"
TARGET_DIR="$HOME/.claude/skills"
TARGET="$TARGET_DIR/sinapse"

mkdir -p "$TARGET_DIR"

if [ -L "$TARGET" ]; then
  CURRENT_TARGET="$(readlink -f "$TARGET" 2>/dev/null || true)"
  RESOLVED_SOURCE="$(readlink -f "$SOURCE" 2>/dev/null || true)"
  if [ -n "$CURRENT_TARGET" ] && [ "$CURRENT_TARGET" = "$RESOLVED_SOURCE" ]; then
    echo "O skill sinapse já está vinculado corretamente ($TARGET -> $SOURCE)."
    exit 0
  else
    echo "Erro: $TARGET já existe como link simbólico apontando para outro destino ($CURRENT_TARGET). Operação cancelada." >&2
    exit 1
  fi
elif [ -e "$TARGET" ]; then
  echo "Erro: $TARGET já existe e não é um link simbólico para este repositório. Operação cancelada." >&2
  exit 1
fi

ln -s "$SOURCE" "$TARGET"
echo "Skill sinapse vinculado com sucesso: $TARGET -> $SOURCE"
