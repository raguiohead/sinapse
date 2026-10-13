#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
REPO="$(cd "$SCRIPT_DIR/.." && pwd)"

ICON_SRC="$REPO/apps/desktop/build/icon.svg"
ICON_DEST_DIR="$HOME/.local/share/icons/hicolor/scalable/apps"
ICON_DEST="$ICON_DEST_DIR/sinapse.svg"

APP_DIR="$HOME/.local/share/applications"
DESKTOP_ENTRY="$APP_DIR/sinapse.desktop"
LAUNCHER="$REPO/scripts/sinapse-desktop.sh"

echo "Instalando ícone em $ICON_DEST..."
mkdir -p "$ICON_DEST_DIR"
cp "$ICON_SRC" "$ICON_DEST"

echo "Criando entrada .desktop em $DESKTOP_ENTRY..."
mkdir -p "$APP_DIR"
cat <<EOF > "$DESKTOP_ENTRY"
[Desktop Entry]
Type=Application
Name=Sinapse
Comment=Orquestrador pessoal de agentes
Exec=$LAUNCHER
Icon=sinapse
Terminal=false
Categories=Development;
StartupWMClass=Sinapse
EOF

chmod +x "$DESKTOP_ENTRY"

if command -v update-desktop-database >/dev/null 2>&1; then
  echo "Atualizando desktop database..."
  update-desktop-database "$APP_DIR" || true
fi

if command -v gtk-update-icon-cache >/dev/null 2>&1; then
  echo "Atualizando cache de ícones..."
  gtk-update-icon-cache -f -q -t "$HOME/.local/share/icons/hicolor" || true
fi

DESKTOP_DIR=""
if command -v xdg-user-dir >/dev/null 2>&1; then
  DESKTOP_DIR="$(xdg-user-dir DESKTOP 2>/dev/null || true)"
fi
if [ -z "$DESKTOP_DIR" ] || [ ! -d "$DESKTOP_DIR" ]; then
  DESKTOP_DIR="$HOME/Desktop"
fi

if [ -d "$DESKTOP_DIR" ]; then
  echo "Copiando atalho para a área de trabalho ($DESKTOP_DIR)..."
  cp "$DESKTOP_ENTRY" "$DESKTOP_DIR/sinapse.desktop"
  chmod +x "$DESKTOP_DIR/sinapse.desktop"
  if command -v gio >/dev/null 2>&1; then
    gio set "$DESKTOP_DIR/sinapse.desktop" metadata::trusted true || true
  fi
fi

echo "Atalho instalado com sucesso!"
