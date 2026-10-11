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
# launchd's own stderr for each job. Outside the checkout on purpose: launchd
# creates this file's folder before the job starts, so under the checkout it
# would recreate part of a moved or deleted one, and the job's own check for
# a missing folder (and its notification) would never fire.
LOGS="$HOME/Library/Logs/trading-harness"
DOMAIN="gui/$(id -u)"
# Health loads first: it does not run at load, and it is what notices a
# book agent that failed to load.
AGENTS=(health tsmom-daily tsmom-monitor)
RETIRED=(scan)

label() { echo "com.jalenedusei.trading.$1"; }

# The paths go into a sed replacement, an XML plist and a shell command line.
# Refuse anything outside a plain character set rather than escape all three.
for p in "$ROOT" "$NPM" "$LOGS"; do
  if [[ ! "$p" =~ ^[A-Za-z0-9._/-]+$ ]]; then
    echo "refusing: '$p' has characters (spaces, quotes, &, \$ ...) the agents can't run safely; move the checkout to a plain path" >&2
    exit 1
  fi
done

running() { launchctl print "$DOMAIN/$(label "$1")" 2>/dev/null | grep -qE '^[[:space:]]+state = running'; }

# Unloading the book mid-scan would kill it between an order and its row.
wait_for_book_scan() {
  for _ in $(seq 1 60); do
    running tsmom-daily || return 0
    echo "waiting for the running book scan to finish..."
    sleep 5
  done
  echo "the book scan is still running after 5 minutes; try again later" >&2
  return 1
}

wait_until_gone() {
  for _ in $(seq 1 50); do
    launchctl print "$DOMAIN/$(label "$1")" >/dev/null 2>&1 || return 0
    sleep 0.2
  done
  echo "$(label "$1") did not unload within 10 s" >&2
  return 1
}

case "${1:-status}" in
  install)
    mkdir -p "$DEST" "$LOGS"
    # Render and check every plist before touching a loaded agent, so a bad
    # template stops the install while the old agents are still running.
    for a in "${AGENTS[@]}"; do
      new="$DEST/$(label "$a").plist.new"
      sed -e "s#__ROOT__#$ROOT#g" -e "s#__NPM__#$NPM#g" -e "s#__LOGS__#$LOGS#g" "$ROOT/ops/launchd/$(label "$a").plist" > "$new"
      if ! plutil -lint "$new" > /dev/null; then
        echo "refusing: $(label "$a") does not render to a valid plist; nothing was changed" >&2
        rm -f "$DEST"/com.jalenedusei.trading.*.plist.new
        exit 1
      fi
    done
    for a in "${RETIRED[@]}"; do
      launchctl bootout "$DOMAIN/$(label "$a")" 2>/dev/null || true
      launchctl disable "$DOMAIN/$(label "$a")"
      echo "retired $(label "$a")"
    done
    wait_for_book_scan || { rm -f "$DEST"/com.jalenedusei.trading.*.plist.new; exit 1; }
    # One agent's failure doesn't stop the rest.
    failed=0
    for a in "${AGENTS[@]}"; do
      dst="$DEST/$(label "$a").plist"
      mv "$dst.new" "$dst"
      launchctl bootout "$DOMAIN/$(label "$a")" 2>/dev/null || true
      if ! wait_until_gone "$a"; then
        echo "NOT UPDATED: $(label "$a") is still running its old definition; run install again" >&2
        failed=1
        continue
      fi
      launchctl enable "$DOMAIN/$(label "$a")" || true
      if launchctl bootstrap "$DOMAIN" "$dst" || { sleep 2; launchctl bootstrap "$DOMAIN" "$dst"; }; then
        echo "loaded $(label "$a") from $dst"
      else
        echo "NOT LOADED: $(label "$a"); run install again" >&2
        failed=1
      fi
    done
    exit "$failed"
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
    wait_for_book_scan || exit 1
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
