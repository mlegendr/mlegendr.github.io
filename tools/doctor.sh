#!/bin/sh
# Diagnose why the app is not showing the code you think it is.
#
#   ./tools/doctor.sh [port]
#
# Checks, in the order things usually go wrong: are you on the right branch,
# have you pulled, is a server running, and is it serving the current files?

PORT=${1:-8123}
ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT" || exit 1

BRANCH="claude/fpl-rules-research-hnxask"
MARKER='Start</th>'          # present only in the current index.html
problems=0

say()  { printf '%s\n' "$1"; }
ok()   { printf '  OK    %s\n' "$1"; }
bad()  { printf '  ISSUE %s\n' "$1"; problems=$((problems + 1)); }
fix()  { printf '        -> %s\n' "$1"; }

say "Repository: $ROOT"
say ""

# 1. Branch -----------------------------------------------------------------
current=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ "$current" = "$BRANCH" ]; then
  ok "on branch $BRANCH"
else
  bad "on branch '$current', not '$BRANCH'"
  fix "git checkout $BRANCH"
fi

# 2. Uncommitted changes, which silently block a pull ------------------------
# Only edits to tracked files can block a pull. Untracked files - above all the
# generated snapshot - are expected, and must never be stashed away.
tracked_changes=$(git status --porcelain --untracked-files=no 2>/dev/null)
if [ -n "$tracked_changes" ]; then
  bad "you have uncommitted edits to tracked files, which can block a pull"
  printf '%s\n' "$tracked_changes" | sed 's/^/          /'
  fix "git stash    (then 'git stash pop' to get them back)"
else
  ok "no uncommitted edits that would block a pull"
fi

# 3. Up to date with the remote ---------------------------------------------
git fetch origin "$BRANCH" --quiet 2>/dev/null
behind=$(git rev-list --count "HEAD..origin/$BRANCH" 2>/dev/null || echo 0)
if [ "${behind:-0}" -gt 0 ]; then
  bad "$behind commit(s) behind origin - you have not pulled the latest code"
  fix "git pull"
else
  ok "up to date with origin"
fi

# 4. The files on disk -------------------------------------------------------
if grep -q "$MARKER" fpl/index.html 2>/dev/null; then
  ok "fpl/index.html on disk has the Start column"
else
  bad "fpl/index.html on disk is missing the Start column"
  fix "git pull, and re-run this script"
fi

# 5. The running server ------------------------------------------------------
say ""
if ! curl -s -o /dev/null --max-time 5 "http://127.0.0.1:$PORT/index.html" 2>/dev/null; then
  bad "nothing is serving on port $PORT"
  fix "./tools/start.sh"
else
  ok "a server is answering on port $PORT"

  if curl -s --max-time 5 "http://127.0.0.1:$PORT/index.html" | grep -q "$MARKER"; then
    ok "the server is serving the current index.html"
  else
    bad "the server is serving an OLD index.html"
    fix "Ctrl-C that server and run ./tools/start.sh again"
  fi

  if curl -sI --max-time 5 "http://127.0.0.1:$PORT/js/app.js" | grep -qi "no-store"; then
    ok "caching is disabled, so a plain browser refresh is enough"
  else
    bad "the old server is still running - it lets your browser cache the code"
    fix "Ctrl-C that server and run ./tools/start.sh again"
    fix "or force one reload: Cmd-Shift-R (Mac) / Ctrl-Shift-R"
  fi
fi

# 6. The data ----------------------------------------------------------------
say ""
if [ -f fpl/data/snapshot.json ]; then
  ok "fpl/data/snapshot.json exists"
  if grep -q '"details"' fpl/data/snapshot.json 2>/dev/null; then
    ok "it includes per-match history, so start probabilities are real"
  else
    bad "no per-match history in the snapshot - Start will fall back to season minutes"
    fix "python3 tools/refresh_fpl_data.py"
  fi
else
  bad "no fpl/data/snapshot.json - the app is running on demo data"
  fix "python3 tools/refresh_fpl_data.py"
fi

say ""
if [ "$problems" -eq 0 ]; then
  say "Everything checks out. If the browser still looks wrong, it is showing a"
  say "cached page: refresh the tab, and check you are on http://localhost:$PORT"
else
  say "$problems issue(s) found - the '->' lines above are the fixes, in order."
fi
