#!/usr/bin/env python3
"""Fetch a fresh FPL data snapshot for the squad manager.

The official API does not send CORS headers, so the browser app cannot call it
directly. Run this instead - it writes fpl/data/snapshot.json, which the app
loads on startup.

    python3 tools/refresh_fpl_data.py

Only the fields the app uses are kept, which kicks the file down from roughly
1.5MB to a couple of hundred kilobytes.
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://fantasy.premierleague.com/api"
BOOTSTRAP = f"{API}/bootstrap-static/"
FIXTURES = f"{API}/fixtures/"
ELEMENT_SUMMARY = f"{API}/element-summary/{{}}/"

# Matches the fields read by fpl/js/snapshot.js.
ELEMENT_FIELDS = [
    "id", "web_name", "first_name", "second_name", "element_type", "team",
    "now_cost", "status", "chance_of_playing_next_round", "news",
    "minutes", "starts", "form", "points_per_game", "total_points", "ep_next",
    "goals_scored", "assists", "clean_sheets", "goals_conceded", "saves",
    "bonus", "bps", "yellow_cards", "red_cards", "own_goals",
    "penalties_saved", "penalties_missed",
    "expected_goals_per_90", "expected_assists_per_90",
    "defensive_contribution", "defensive_contribution_per_90",
    "selected_by_percent",
]
TEAM_FIELDS = [
    "id", "name", "short_name", "strength",
    "strength_attack_home", "strength_attack_away",
    "strength_defence_home", "strength_defence_away",
]
EVENT_FIELDS = ["id", "name", "deadline_time", "is_current", "is_next", "finished"]
FIXTURE_FIELDS = [
    "id", "event", "team_h", "team_a", "team_h_difficulty", "team_a_difficulty",
    "finished", "kickoff_time",
]


def fetch(url: str, timeout: int = 30) -> dict | list:
    request = urllib.request.Request(url, headers={"User-Agent": "fpl-squad-manager/1.0"})
    with urllib.request.urlopen(request, timeout=timeout) as response:
        return json.load(response)


def pick(row: dict, fields: list[str]) -> dict:
    return {f: row.get(f) for f in fields if f in row}


def build_snapshot(detail_ids: list[int] | None = None) -> dict:
    bootstrap = fetch(BOOTSTRAP)
    fixtures = fetch(FIXTURES)

    snapshot = {
        "generated_at": datetime.now(timezone.utc).isoformat(),
        "source": API,
        "elements": [pick(e, ELEMENT_FIELDS) for e in bootstrap["elements"]],
        "teams": [pick(t, TEAM_FIELDS) for t in bootstrap["teams"]],
        "events": [pick(e, EVENT_FIELDS) for e in bootstrap["events"]],
        "fixtures": [pick(f, FIXTURE_FIELDS) for f in fixtures],
    }

    if detail_ids:
        # Per-player history, useful as a minutes prior while the season is young.
        details = {}
        for pid in detail_ids:
            try:
                summary = fetch(ELEMENT_SUMMARY.format(pid))
            except urllib.error.URLError as exc:
                print(f"  ! could not fetch detail for {pid}: {exc}", file=sys.stderr)
                continue
            details[str(pid)] = {
                "history_past": summary.get("history_past", []),
                "recent": summary.get("history", [])[-6:],
            }
        snapshot["details"] = details

    return snapshot


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", default="fpl/data/snapshot.json", help="where to write the snapshot")
    parser.add_argument("--detail-ids", default="", help="comma-separated player ids to fetch history for")
    args = parser.parse_args()

    detail_ids = [int(x) for x in args.detail_ids.split(",") if x.strip()]

    print(f"Fetching {BOOTSTRAP} ...")
    try:
        snapshot = build_snapshot(detail_ids)
    except urllib.error.URLError as exc:
        print(f"Could not reach the FPL API: {exc}", file=sys.stderr)
        print("If you are behind a proxy or firewall, run this on a machine with "
              "direct internet access and copy the resulting JSON across.", file=sys.stderr)
        return 1

    out = Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(snapshot, separators=(",", ":")))

    current = next((e["id"] for e in snapshot["events"] if e.get("is_current")), None)
    nxt = next((e["id"] for e in snapshot["events"] if e.get("is_next")), None)
    size_kb = out.stat().st_size / 1024
    print(f"Wrote {out} ({size_kb:.0f} KB): "
          f"{len(snapshot['elements'])} players, {len(snapshot['fixtures'])} fixtures, "
          f"current GW {current}, next GW {nxt}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
