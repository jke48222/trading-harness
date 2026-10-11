#!/usr/bin/env bash
# Install, inspect or remove the launchd agents that run the paper book.
#
#   scripts/agents.sh install    render ops/launchd/*.plist for this checkout and (re)load them
#   scripts/agents.sh status     state, last exit code and run count of each agent
#   scripts/agents.sh uninstall  unload the agents and remove their plists
#
# The retired 5m crossover agent (com.jalenedusei.trading.scan) is unloaded and
# disabled by `install`; `launchctl enable gui/$UID/com.jalenedusei.trading.scan`
# brings it back.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
NPM="$(command -v npm)"
DEST="$HOME/Library/LaunchAgents"
DOMAIN="gui/$(id -u)"
AGENTS=(tsmom-daily health tsmom-monitor)
RETIRED=(scan)

label() { echo "com.jalenedusei.trading.$1"; }

case "${1:-status}" in
  install)
    mkdir -p "$DEST"
    for a in "${RETIRED[@]}"; do
      launchctl bootout "$DOMAIN/$(label "$a")" 2>/dev/null || true
      launchctl disable "$DOMAIN/$(label "$a")"
      echo "retired $(label "$a")"
    done
    for a in "${AGENTS[@]}"; do
      src="$ROOT/ops/launchd/$(label "$a").plist"
      dst="$DEST/$(label "$a").plist"
      sed -e "s#__ROOT__#$ROOT#g" -e "s#__NPM__#$NPM#g" "$src" > "$dst.tmp"
      plutil -lint "$dst.tmp" > /dev/null
      mv "$dst.tmp" "$dst"
      launchctl bootout "$DOMAIN/$(label "$a")" 2>/dev/null || true
      launchctl bootstrap "$DOMAIN" "$dst"
      echo "loaded $(label "$a") from $dst"
    done
    ;;
  status)
    for a in "${AGENTS[@]}" "${RETIRED[@]}"; do
      if out="$(launchctl print "$DOMAIN/$(label "$a")" 2>/dev/null)"; then
        echo "$(label "$a"): $(echo "$out" | awk -F' = ' '/^[[:space:]]+(state|runs|last exit code) = /{ k=$1; gsub(/^[[:space:]]+/, "", k); if (!seen[k]++) printf "%s %s · ", k, $2 }')"
      else
        echo "$(label "$a"): not loaded"
      fi
    done
    ;;
  uninstall)
    for a in "${AGENTS[@]}"; do
      launchctl bootout "$DOMAIN/$(label "$a")" 2>/dev/null || true
      rm -f "$DEST/$(label "$a").plist"
      echo "removed $(label "$a")"
    done
    ;;
  *)
    echo "usage: $0 install|status|uninstall" >&2
    exit 2
    ;;
esac
