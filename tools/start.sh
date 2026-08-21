#!/bin/sh
# Start the FPL Squad Manager: refresh the data, then serve the app.
#
#   ./tools/start.sh          refresh data and serve on port 8123
#   ./tools/start.sh 9000     serve on a different port
#   ./tools/start.sh --no-refresh
#
# Run from anywhere; it locates the repository itself.

set -e

PORT=8123
REFRESH=1
for arg in "$@"; do
  case "$arg" in
    --no-refresh) REFRESH=0 ;;
    ''|*[!0-9]*) ;;
    *) PORT="$arg" ;;
  esac
done

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if command -v python3 >/dev/null 2>&1; then PY=python3
elif command -v python  >/dev/null 2>&1; then PY=python
else
  echo "Python 3 is required but was not found on your PATH." >&2
  exit 1
fi

if [ "$REFRESH" = "1" ]; then
  echo "Refreshing FPL data..."
  if ! "$PY" tools/refresh_fpl_data.py; then
    echo
    echo "Could not refresh. Starting anyway with whatever data is already there —"
    echo "the banner at the top of the page will tell you what you are looking at."
    echo
  fi
fi

echo
echo "  FPL Squad Manager:  http://localhost:$PORT"
echo "  Stop with Ctrl-C."
echo
exec "$PY" -m http.server -d fpl "$PORT" --bind 127.0.0.1
