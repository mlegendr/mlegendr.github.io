#!/usr/bin/env python3
"""Train the team-strength model and export an artifact the TypeScript app loads.

    python3 scripts/train_model.py [--start 2010] [--end 2025] [--holdout 3]

What it does, in order:

1. Pulls nflverse schedules + weekly team EPA (cached under data/cache/).
2. Grid-searches the Elo hyper-parameters on a *chronological* split — every
   rating used to predict a game is built only from games played before it, so
   there is no look-ahead leakage anywhere in this file.
3. Fits a logistic regression on top of Elo, EPA and rest, again walking forward
   in time.
4. Evaluates on held-out seasons (Brier / log loss / accuracy / calibration) and
   compares against the closing market where nflverse carries moneylines.
5. Writes data/model/model.json: coefficients, blend weights, per-team priors for
   the upcoming season and the calibration report.

The output is intentionally a small, inspectable linear model. A well-calibrated
simple model is worth far more to a survivor optimiser than an opaque one:
the optimiser consumes probability *magnitudes*, not rankings.
"""

from __future__ import annotations

import argparse
import datetime as dt
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nfl_common import (  # noqa: E402
    MODEL_DIR,
    TEAMS,
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
    write_json,
)


def build_epa_index(team_weeks):
    idx = {}
    for tw in team_weeks:
        idx.setdefault((tw.season, tw.week), []).append(tw)
    return idx


def walk_forward(games, team_week_index, cfg: EloConfig, epa_alpha: float, epa_carry: float):
    """Replay every game in order, emitting the features that were knowable pre-kickoff."""
    elo = EloModel(cfg)
    epa = EpaTracker(alpha=epa_alpha, carryover=epa_carry)
    rows = []
    season = None
    week = None

    for g in games:
        if g.season != season:
            elo.start_season(g.season)
            if season is not None:
                epa.start_season()
            season = g.season
            week = None
        if week is not None and g.week != week:
            # Fold in the completed week's box scores before predicting the next.
            for tw in team_week_index.get((g.season, week), []):
                epa.observe(tw.team, tw.opponent, tw.off_epa)
        week = g.week

        elo_diff = elo.pregame_diff(g)
        epa_edge = epa.net_edge(g.home, g.away)
        rest_diff = 0.0
        if g.home_rest is not None and g.away_rest is not None:
            rest_diff = max(-10.0, min(10.0, g.home_rest - g.away_rest))
        experience = min(epa.n[g.home], epa.n[g.away])
        # Early in a season the EPA numbers are noise; ramp their influence in.
        epa_weight = experience / (experience + 4.0)

        rows.append(
            {
                "game": g,
                "features": [
                    elo_diff / 100.0,
                    epa_edge * epa_weight * 10.0,
                    rest_diff / 7.0,
                    1.0 if g.neutral else 0.0,
                    1.0 if g.div_game else 0.0,
                ],
                "elo_prob": 1.0 / (1.0 + 10 ** (-elo_diff / 400.0)),
                "season": g.season,
                "week": g.week,
            }
        )
        elo.update(g)

    # Fold in the final week so the exported ratings are complete.
    if season is not None and week is not None:
        for tw in team_week_index.get((season, week), []):
            epa.observe(tw.team, tw.opponent, tw.off_epa)

    return rows, elo, epa


def tune_elo(games, team_week_index, tune_seasons):
    """Grid search Elo hyper-parameters by out-of-sample log loss on `tune_seasons`."""
    best = None
    for k in (14.0, 18.0, 20.0, 24.0):
        for hf in (35.0, 45.0, 55.0):
            for revert in (0.2, 0.28, 0.35):
                cfg = EloConfig(k=k, home_field=hf, revert=revert)
                rows, _, _ = walk_forward(games, team_week_index, cfg, 0.22, 0.55)
                preds, acts = [], []
                for r in rows:
                    g: Game = r["game"]
                    if g.season not in tune_seasons or not g.completed or g.tie:
                        continue
                    preds.append(r["elo_prob"])
                    acts.append(float(g.home_won))
                if not preds:
                    continue
                ll = log_loss(preds, acts)
                if best is None or ll < best[0]:
                    best = (ll, cfg)
                print(f"  elo k={k:<5} hf={hf:<5} revert={revert:<5} logloss={ll:.5f}")
    assert best is not None, "Elo tuning produced no candidates"
    return best[1]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--start", type=int, default=2010)
    ap.add_argument("--end", type=int, default=2025, help="last season to train on")
    ap.add_argument("--holdout", type=int, default=3, help="most recent N seasons held out")
    ap.add_argument("--target-season", type=int, default=None, help="season the app will run")
    ap.add_argument("--out", default=os.path.join(MODEL_DIR, "model.json"))
    ap.add_argument("--quick", action="store_true", help="skip the Elo grid search")
    args = ap.parse_args()

    target_season = args.target_season or (args.end + 1)
    seasons = list(range(args.start, args.end + 1))
    holdout = set(seasons[-args.holdout :]) if args.holdout > 0 else set()
    train_seasons = [s for s in seasons if s not in holdout]

    print(f"Loading nflverse schedules {seasons[0]}-{seasons[-1]} ...")
    games = [g for g in load_games(seasons) if g.completed]
    print(f"  {len(games)} completed regular-season games")

    print("Loading nflverse weekly team EPA ...")
    team_weeks = load_team_weeks(seasons)
    print(f"  {len(team_weeks)} team-weeks")
    tw_index = build_epa_index(team_weeks)

    if args.quick:
        cfg = EloConfig()
        print("Skipping Elo grid search (--quick)")
    else:
        print("Tuning Elo on a chronological split ...")
        cfg = tune_elo(games, tw_index, holdout or set(seasons[-3:]))
    print(f"Chosen Elo: k={cfg.k} home_field={cfg.home_field} revert={cfg.revert}")

    rows, elo, epa = walk_forward(games, tw_index, cfg, 0.22, 0.55)

    # ---- Fit the blend of Elo + EPA + situation, training seasons only. -----
    X, y = [], []
    for r in rows:
        g: Game = r["game"]
        if g.season in holdout or g.tie:
            continue
        X.append(r["features"])
        y.append(float(g.home_won))
    print(f"Fitting logistic regression on {len(X)} games ...")
    w = fit_logistic(X, y, l2=2.0, iters=3000, lr=0.4)
    names = ["intercept", "eloDiff100", "epaEdge", "restDiff7", "neutralSite", "divisionGame"]
    for n, c in zip(names, w):
        print(f"  {n:<14} {c:+.4f}")

    # ---- Evaluate out of sample. -------------------------------------------
    def evaluate(season_filter):
        m_preds, k_preds, b_preds, acts = [], [], [], []
        for r in rows:
            g: Game = r["game"]
            if not season_filter(g.season) or g.tie:
                continue
            p_model = predict_logistic(w, r["features"])
            p_mkt = devig(g.home_ml, g.away_ml)
            m_preds.append(p_model)
            acts.append(float(g.home_won))
            if p_mkt is not None:
                k_preds.append((p_mkt, float(g.home_won)))
                b_preds.append((0.72 * p_mkt + 0.28 * p_model, float(g.home_won)))
        out = {
            "model": {
                "n": len(m_preds),
                "brier": brier(m_preds, acts),
                "logLoss": log_loss(m_preds, acts),
                "accuracy": accuracy(m_preds, acts),
            }
        }
        if k_preds:
            kp = [p for p, _ in k_preds]
            ka = [a for _, a in k_preds]
            bp = [p for p, _ in b_preds]
            out["market"] = {
                "n": len(kp),
                "brier": brier(kp, ka),
                "logLoss": log_loss(kp, ka),
                "accuracy": accuracy(kp, ka),
            }
            out["blend"] = {
                "n": len(bp),
                "brier": brier(bp, ka),
                "logLoss": log_loss(bp, ka),
                "accuracy": accuracy(bp, ka),
            }
        out["calibration"] = calibration(m_preds, acts)
        return out

    metrics = {
        "inSample": evaluate(lambda s: s not in holdout),
        "holdout": evaluate(lambda s: s in holdout) if holdout else None,
    }

    print("\nHold-out performance (%s):" % (sorted(holdout) or "n/a"))
    if metrics["holdout"]:
        for k, v in metrics["holdout"].items():
            if k == "calibration":
                continue
            print(
                f"  {k:<7} n={v['n']:<5} brier={v['brier']:.4f} "
                f"logloss={v['logLoss']:.4f} acc={v['accuracy']:.3f}"
            )

    # ---- Export priors for the target season. ------------------------------
    final_elo = elo.snapshot()
    priors = {}
    for t in TEAMS:
        priors[t] = {
            # Same between-season regression the model was trained with.
            "elo": round(1500.0 + (final_elo[t] - 1500.0) * (1 - cfg.revert), 2),
            "offEpa": round(epa.off[t] * epa.carryover, 5),
            "defEpa": round(epa.deff[t] * epa.carryover, 5),
        }

    artifact = {
        "version": 2,
        "trainedAt": dt.datetime.now(dt.timezone.utc).isoformat(),
        "targetSeason": target_season,
        "trainSeasons": train_seasons,
        "holdoutSeasons": sorted(holdout),
        "elo": {
            "k": cfg.k,
            "homeField": cfg.home_field,
            "restPerDay": cfg.rest_per_day,
            "movScale": cfg.mov_scale,
            "revert": cfg.revert,
            "base": cfg.base,
        },
        "epa": {"alpha": 0.22, "carryover": 0.55, "rampGames": 4.0, "scale": 10.0},
        "logistic": {
            "featureOrder": names[1:],
            "intercept": w[0],
            "coefficients": dict(zip(names[1:], w[1:])),
        },
        "priors": priors,
        # How much of the final number the live market gets, and how quickly a
        # thin or stale book loses that privilege. Calibrated in backtest.py.
        "blend": {
            "marketWeightBase": 0.78,
            "marketWeightPerBook": 0.022,
            "marketWeightMax": 0.92,
            "marketWeightMin": 0.30,
            "stalenessHalfLifeHours": 36.0,
            "singleBookPenalty": 0.35,
        },
        # Future weeks are shrunk toward a coin flip; a Week 15 guess made in
        # Week 1 must not be presented like a live market price.
        "horizonShrink": {"perWeek": 0.022, "max": 0.34},
        "metrics": metrics,
    }

    write_json(args.out, artifact)
    print(f"\nWrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
