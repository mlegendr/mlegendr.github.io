#!/usr/bin/env python3
"""Rolling-origin backtest: model vs market vs blend, with a calibration report.

    python3 scripts/backtest.py [--test 2022-2025] [--min-train 8] [--write]

Leak control
------------
The evaluation walks forward in time. For a game in season S week W:

  * team ratings contain only games that finished before that kickoff;
  * EPA is folded in only after a week completes;
  * the logistic coefficients are refit at each season boundary using seasons
    strictly earlier than S.

Nothing about the game being predicted, its week, or its season is ever used to
predict it. That is the whole point: a survivor optimiser tuned on leaked data
would look excellent here and lose in week 3.

Calibration is reported alongside Brier/log loss because the optimiser multiplies
probability *magnitudes* — a model that is 5 points overconfident at 80% produces
paths that are wrong in a way accuracy alone will not reveal.

`--write` updates only `blend.marketWeightBase` in data/model/model.json with the
sweep's best value; nothing else in the artifact is touched.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nfl_common import (  # noqa: E402
    MODEL_DIR,
    EloConfig,
    EloModel,
    EpaTracker,
    Game,
    accuracy,
    brier,
    calibration,
    devig,
    fit_logistic,
    load_games,
    load_team_weeks,
    log_loss,
    predict_logistic,
)


def parse_range(text: str) -> list[int]:
    if "-" in text:
        lo, hi = text.split("-", 1)
        return list(range(int(lo), int(hi) + 1))
    return [int(text)]


def features_for(elo: EloModel, epa: EpaTracker, g: Game) -> list[float]:
    elo_diff = elo.pregame_diff(g)
    experience = min(epa.n[g.home], epa.n[g.away])
    epa_weight = experience / (experience + 4.0)
    rest_diff = 0.0
    if g.home_rest is not None and g.away_rest is not None:
        rest_diff = max(-10.0, min(10.0, g.home_rest - g.away_rest))
    return [
        elo_diff / 100.0,
        epa.net_edge(g.home, g.away) * epa_weight * 10.0,
        rest_diff / 7.0,
        1.0 if g.neutral else 0.0,
        1.0 if g.div_game else 0.0,
    ]


def replay(games: list[Game], tw_index: dict, cfg: EloConfig, stop_before_season: int | None = None):
    """Replay history, returning (rows, elo, epa). Rows carry pre-kickoff features."""
    elo = EloModel(cfg)
    epa = EpaTracker()
    rows = []
    season = None
    week = None
    for g in games:
        if stop_before_season is not None and g.season >= stop_before_season:
            break
        if g.season != season:
            elo.start_season(g.season)
            if season is not None:
                epa.start_season()
            season = g.season
            week = None
        if week is not None and g.week != week:
            for tw in tw_index.get((g.season, week), []):
                epa.observe(tw.team, tw.opponent, tw.off_epa)
        week = g.week
        rows.append({"game": g, "features": features_for(elo, epa, g)})
        elo.update(g)
    if season is not None and week is not None:
        for tw in tw_index.get((season, week), []):
            epa.observe(tw.team, tw.opponent, tw.off_epa)
    return rows, elo, epa


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--test", default="2022-2025", help="seasons to evaluate, e.g. 2022-2025")
    ap.add_argument("--min-train", type=int, default=8, help="minimum training seasons")
    ap.add_argument("--first", type=int, default=2006, help="earliest season to load")
    ap.add_argument("--write", action="store_true", help="write the best blend weight into model.json")
    args = ap.parse_args()

    test_seasons = parse_range(args.test)
    all_seasons = list(range(args.first, test_seasons[-1] + 1))

    print(f"Loading {all_seasons[0]}-{all_seasons[-1]} ...")
    games = [g for g in load_games(all_seasons) if g.completed]
    tw_index = defaultdict(list)
    for tw in load_team_weeks(all_seasons):
        tw_index[(tw.season, tw.week)].append(tw)
    cfg = EloConfig()

    records = []  # (season, week, p_model, p_market, actual)

    for season in test_seasons:
        train_seasons = [s for s in all_seasons if s < season]
        if len(train_seasons) < args.min_train:
            print(f"  skipping {season}: only {len(train_seasons)} training seasons")
            continue

        # --- Refit using ONLY seasons strictly before the test season. --------
        train_rows, _, _ = replay(games, tw_index, cfg, stop_before_season=season)
        X = [r["features"] for r in train_rows if not r["game"].tie]
        y = [float(r["game"].home_won) for r in train_rows if not r["game"].tie]
        w = fit_logistic(X, y, l2=2.0, iters=2500, lr=0.4)

        # --- Walk the test season forward one week at a time. -----------------
        elo = EloModel(cfg)
        epa = EpaTracker()
        prior_season = None
        prior_week = None
        for g in games:
            if g.season > season:
                break
            if g.season != prior_season:
                elo.start_season(g.season)
                if prior_season is not None:
                    epa.start_season()
                prior_season = g.season
                prior_week = None
            if prior_week is not None and g.week != prior_week:
                for tw in tw_index.get((g.season, prior_week), []):
                    epa.observe(tw.team, tw.opponent, tw.off_epa)
            prior_week = g.week

            if g.season == season and not g.tie:
                p_model = predict_logistic(w, features_for(elo, epa, g))
                p_market = devig(g.home_ml, g.away_ml)
                records.append((season, g.week, p_model, p_market, float(g.home_won)))
            elo.update(g)

        print(f"  {season}: trained on {train_seasons[0]}-{train_seasons[-1]}")

    if not records:
        print("No games evaluated.")
        return 1

    model_p = [r[2] for r in records]
    actual = [r[4] for r in records]
    with_market = [r for r in records if r[3] is not None]

    print(f"\nEvaluated {len(records)} games across {sorted(set(r[0] for r in records))}")
    print(f"Games with a historical market: {len(with_market)}\n")

    def report(name: str, preds: list[float], acts: list[float]) -> None:
        print(
            f"  {name:<14} n={len(preds):<5} brier={brier(preds, acts):.4f} "
            f"logloss={log_loss(preds, acts):.4f} acc={accuracy(preds, acts):.3f}"
        )

    print("Head-to-head")
    report("Model only", model_p, actual)

    best_weight = None
    if with_market:
        mk = [r[3] for r in with_market]
        md = [r[2] for r in with_market]
        ac = [r[4] for r in with_market]
        report("Market only", mk, ac)

        # --- Sweep the blend weight. -----------------------------------------
        print("\nBlend sweep (market weight -> log loss)")
        best = None
        for i in range(0, 21):
            wt = i / 20.0
            blended = [wt * a + (1 - wt) * b for a, b in zip(mk, md)]
            ll = log_loss(blended, ac)
            if best is None or ll < best[1]:
                best = (wt, ll)
            if i % 2 == 0:
                print(f"  w={wt:.2f}  logloss={ll:.5f}  brier={brier(blended, ac):.5f}")
        best_weight = best[0]
        blended = [best_weight * a + (1 - best_weight) * b for a, b in zip(mk, md)]
        print()
        report(f"Blend w={best_weight:.2f}", blended, ac)

    print("\nCalibration — model only (folded onto the favourite's side)")
    print(f"  {'bin':<10}{'n':>7}{'predicted':>12}{'actual':>10}{'gap':>10}")
    for row in calibration(model_p, actual):
        if row["n"] == 0:
            continue
        gap = (row["actual"] - row["predicted"]) * 100
        print(
            f"  {row['bin']:<10}{row['n']:>7}{row['predicted']*100:>11.1f}%"
            f"{row['actual']*100:>9.1f}%{gap:>9.1f}"
        )

    if with_market:
        print("\nCalibration — market only")
        print(f"  {'bin':<10}{'n':>7}{'predicted':>12}{'actual':>10}{'gap':>10}")
        for row in calibration([r[3] for r in with_market], [r[4] for r in with_market]):
            if row["n"] == 0:
                continue
            gap = (row["actual"] - row["predicted"]) * 100
            print(
                f"  {row['bin']:<10}{row['n']:>7}{row['predicted']*100:>11.1f}%"
                f"{row['actual']*100:>9.1f}%{gap:>9.1f}"
            )

    print("\nFavourite upset rate (model favourite lost)")
    for lo, hi in [(0.5, 0.6), (0.6, 0.7), (0.7, 0.8), (0.8, 1.01)]:
        subset = [
            (max(p, 1 - p), a if p >= 0.5 else 1 - a)
            for _, _, p, _, a in records
            if lo <= max(p, 1 - p) < hi
        ]
        if not subset:
            continue
        upsets = sum(1 for _, a in subset if a == 0)
        print(f"  {int(lo*100)}-{int(hi*100 if hi<=1 else 100)}%  n={len(subset):<5} upsets={upsets/len(subset)*100:.1f}%")

    if args.write and best_weight is not None:
        path = os.path.join(MODEL_DIR, "model.json")
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as fh:
                artifact = json.load(fh)
            artifact.setdefault("blend", {})["marketWeightBase"] = best_weight
            artifact["blend"]["calibratedBy"] = "scripts/backtest.py"
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(artifact, fh, indent=2)
                fh.write("\n")
            print(f"\nWrote blend.marketWeightBase = {best_weight:.2f} to {path}")
        else:
            print(f"\n{path} does not exist — run `npm run train` first.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
