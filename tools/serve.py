#!/usr/bin/env python3
"""Serve the app with caching turned off.

Browsers cache JavaScript aggressively, so after a `git pull` a normal reload
can still run the old code. Sending no-store means a plain refresh always picks
up the current files - no hard reload, no "why is nothing changing".

    python3 tools/serve.py [port]
"""

import sys
from functools import partial
from http.server import HTTPServer, SimpleHTTPRequestHandler
from pathlib import Path


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, fmt, *args):
        # Only report problems; a request log per asset drowns the useful output.
        status = args[1] if len(args) > 1 else ""
        if str(status).startswith(("4", "5")) and "favicon" not in str(args[0]):
            sys.stderr.write(f"  {fmt % args}\n")


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8123
    root = Path(__file__).resolve().parent.parent / "fpl"
    if not root.is_dir():
        print(f"Could not find {root}", file=sys.stderr)
        return 1

    handler = partial(NoCacheHandler, directory=str(root))
    server = HTTPServer(("127.0.0.1", port), handler)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
