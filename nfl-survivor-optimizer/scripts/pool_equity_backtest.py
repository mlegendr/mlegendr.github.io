#!/usr/bin/env python3
"""Historical pool-equity backtest: does modelling the field actually win pools?

    python3 scripts/pool_equity_backtest.py [--seasons 2022-2025] [--pool-sizes 5,20]

Three strategies compete inside simulated survivor pools built on real historical
seasons and real closing-market probabilities:

    A  largest-favourite   take the highest de-vigged win probability available
    B  path-optimizer      the app's existing naive survival optimizer
                           (exact no-repeat assignment, re-solved every week)
    C  pool-equity         nested Monte Carlo: for each candidate, simulate the
                           rest of the pool and take the highest expected prize
                           equity

Every strategy obeys the one-use-per-team constraint, and — the point of the
exercise — each NFL game is sampled ONCE per simulated week, so entries on the
same team share a fate.

Judged on winning the pool, not on surviving. `--metric survival` is available
but average survival week is explicitly the wrong yardstick for strategy C: its
whole purpose is to trade a little survival for a lot of equity.

Runtime warning: strategy C is a nested simulation. Defaults are deliberately
modest; raise --inner-sims and --reps for tighter numbers.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nfl_common import EloConfig, fit_logistic, load_games, load_team_weeks  # noqa: E402
from survivor_backtest import blended, optimal_first_pick, prepare_season  # noqa: E402
from backtest import replay  # noqa: E402


def softmax_pick(options, temperature, rng):
    """Opponent policy: soft preference for win probability, never deterministic."""
    if not options:
        return None
    keys = list(options)
    scaled = [options[k] / max(0.05, temperature) for k in keys]
    m = max(scaled)
    exps = [math.exp(s - m) for s in scaled]
    total = sum(exps)
    r = rng.random() * total
    acc = 0.0
    for k, e in zip(keys, exps):
        acc += e
        if r < acc:
            return k
    return keys[-1]


def simulate_pool(
    probs, weeks, available_teams, user_strategy, pool_size, temperature, rng,
    game_of_team, opponents_probs, inner_sims, horizon,
):
    """Run one complete pool. Returns (user_won, co_winners, user_last_week)."""
    entries = []
    for i in range(pool_size):
        entries.append({"id": i, "user": i == 0, "used": set(), "alive": True, "out": None})

    for wi, week in enumerate(weeks):
        alive = [e for e in entries if e["alive"]]
        if not alive:
            break

        picks = {}
        for e in alive:
            options = {
                t: p
                for t, p in probs.get(week, {}).items()
                if t not in e["used"] and t in available_teams
            }
            if not options:
                e["alive"] = False
                e["out"] = week
                continue
            if e["user"]:
                picks[e["id"]] = choose_user(
                    user_strategy, probs, weeks[wi:], options, e["used"],
                    available_teams, entries, week, rng, game_of_team,
                    opponents_probs, temperature, inner_sims, horizon,
                )
            else:
                picks[e["id"]] = softmax_pick(options, temperature, rng)

        # One outcome per game, shared by everyone who picked into it.
        game_uniform = {}
        for e in alive:
            team = picks.get(e["id"])
            if team is None:
                continue
            gid = game_of_team.get((week, team))
            if gid is not None and gid not in game_uniform:
                game_uniform[gid] = rng.random()

        for e in alive:
            team = picks.get(e["id"])
            if team is None:
                continue
            gid = game_of_team.get((week, team))
            p = probs.get(week, {}).get(team, 0.5)
            survived = gid is not None and game_uniform[gid] < p
            if survived:
                e["used"].add(team)
            else:
                e["alive"] = False
                e["out"] = week

    survivors = [e for e in entries if e["alive"]]
    if not survivors:
        # Everyone went out; the last group to fall shares (matching the app's
        # SHARE_AMONG_LAST default).
        last = max((e["out"] or 0) for e in entries)
        survivors = [e for e in entries if e["out"] == last]
    user = entries[0]
    user_won = any(e["user"] for e in survivors)
    return user_won, len(survivors), (user["out"] or weeks[-1])


def choose_user(
    strategy, probs, remaining_weeks, options, used, available_teams, entries,
    week, rng, game_of_team, opponents_probs, temperature, inner_sims, horizon,
):
    if strategy == "largest-favourite":
        return max(options, key=lambda t: options[t])

    if strategy == "path-optimizer":
        window = remaining_weeks[:horizon]
        pick = optimal_first_pick(probs, window, available_teams - used)
        return pick or max(options, key=lambda t: options[t])

    # pool-equity: nested Monte Carlo that plays the pool OUT TO COMPLETION.
    #
    # A one-week nested simulation would maximise "expected 1/survivors this
    # week", which chases differentiation with no regard for future value and
    # is strictly worse than the naive optimizer. The app simulates through
    # pool completion, so the backtest must too or it is not testing the app.
    best_team, best_equity = None, -1.0
    opponents = [e for e in entries[1:] if e["alive"]]
    shortlist = sorted(options, key=lambda t: -options[t])[:4]
    for cand in shortlist:
        equity = 0.0
        for s in range(inner_sims):
            sub = random.Random((hash((cand, s, week)) ^ 0x5bf03635) & 0xFFFFFFFF)
            equity += rollout_equity(
                cand, probs, remaining_weeks, used, available_teams, opponents,
                sub, game_of_team, temperature, horizon,
            )
        equity /= max(1, inner_sims)
        if equity > best_equity:
            best_equity, best_team = equity, cand
    return best_team or max(options, key=lambda t: options[t])


def rollout_equity(
    candidate, probs, remaining_weeks, user_used, available_teams, opponents,
    rng, game_of_team, temperature, horizon,
):
    """Play the remaining pool once and return the user's prize equity.

    Mirrors the TypeScript simulator: one uniform per NFL game per week (so
    entries on the same team share a fate), and an approximate receding-horizon
    rollout for the user's own later picks.
    """
    user = {"used": set(user_used), "alive": True, "out": None}
    field = [{"used": set(o["used"]), "alive": True, "out": None} for o in opponents]

    for wi, week in enumerate(remaining_weeks):
        board = probs.get(week, {})
        if not board:
            continue
        picks = []

        if user["alive"]:
            if wi == 0:
                team = candidate
            else:
                opts = {
                    t: p for t, p in board.items()
                    if t not in user["used"] and t in available_teams
                }
                # Receding-horizon: prefer the safest team that also keeps a
                # strong future week available, approximated by the assignment
                # solver over the next `horizon` weeks.
                team = optimal_first_pick(
                    probs, remaining_weeks[wi : wi + horizon], available_teams - user["used"]
                ) or (max(opts, key=lambda t: opts[t]) if opts else None)
            picks.append((user, team))

        for e in field:
            if not e["alive"]:
                continue
            opts = {
                t: p for t, p in board.items()
                if t not in e["used"] and t in available_teams
            }
            picks.append((e, softmax_pick(opts, temperature, rng) if opts else None))

        game_uniform = {}
        for _e, team in picks:
            if team is None:
                continue
            gid = game_of_team.get((week, team))
            if gid is not None and gid not in game_uniform:
                game_uniform[gid] = rng.random()

        for e, team in picks:
            if team is None:
                e["alive"] = False
                e["out"] = week
                continue
            gid = game_of_team.get((week, team))
            if gid is not None and game_uniform[gid] < board.get(team, 0.5):
                e["used"].add(team)
            else:
                e["alive"] = False
                e["out"] = week

        if not user["alive"]:
            # Equity is settled at zero unless everyone fell in the same week.
            if all(not e["alive"] for e in field) and all(
                e["out"] == week for e in field
            ):
                return 1.0 / (1 + len(field))
            return 0.0

    survivors = 1 + sum(1 for e in field if e["alive"])
    return 1.0 / survivors


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seasons", default="2023-2025")
    ap.add_argument("--first", type=int, default=2012)
    ap.add_argument("--pool-sizes", default="5,20")
    ap.add_argument("--reps", type=int, default=60, help="pool realisations per season/size")
    ap.add_argument("--inner-sims", type=int, default=120, help="nested sims for strategy C")
    ap.add_argument("--temperature", type=float, default=0.06, help="opponent softmax temperature")
    ap.add_argument("--horizon", type=int, default=6)
    ap.add_argument("--seed", type=int, default=20260101)
    args = ap.parse_args()

    lo, hi = (args.seasons.split("-") + [args.seasons])[:2]
    test_seasons = list(range(int(lo), int(hi) + 1))
    pool_sizes = [int(x) for x in args.pool_sizes.split(",")]
    all_seasons = list(range(args.first, test_seasons[-1] + 1))

    print(f"Loading {all_seasons[0]}-{all_seasons[-1]} ...")
    games = [g for g in load_games(all_seasons) if g.completed]
    tw_index = defaultdict(list)
    for tw in load_team_weeks(all_seasons):
        tw_index[(tw.season, tw.week)].append(tw)
    cfg = EloConfig()

    strategies = ["largest-favourite", "path-optimizer", "pool-equity"]
    agg = {
        (s, n): {"wins": 0, "equity": 0.0, "sole": 0, "weeks": 0, "reps": 0}
        for s in strategies
        for n in pool_sizes
    }

    for season in test_seasons:
        train_rows, _, _ = replay(games, tw_index, cfg, stop_before_season=season)
        X = [r["features"] for r in train_rows if not r["game"].tie]
        y = [float(r["game"].home_won) for r in train_rows if not r["game"].tie]
        coeffs = fit_logistic(X, y, l2=2.0, iters=1200, lr=0.4)

        market, model, _won = prepare_season(games, tw_index, season, coeffs, cfg)
        weeks = sorted(w for w in model if model[w])
        if not weeks:
            continue
        probs = blended(market, model, weeks)
        available = {t for w in weeks for t in probs[w]}

        game_of_team = {}
        for g in games:
            if g.season != season:
                continue
            game_of_team[(g.week, g.home)] = g.game_id
            game_of_team[(g.week, g.away)] = g.game_id

        for size in pool_sizes:
            for rep in range(args.reps):
                for strat in strategies:
                    rng = random.Random(args.seed + rep * 7919 + size * 31 + hash(season) % 1000)
                    won, co, last = simulate_pool(
                        probs, weeks, available, strat, size, args.temperature, rng,
                        game_of_team, None, args.inner_sims, args.horizon,
                    )
                    a = agg[(strat, size)]
                    a["reps"] += 1
                    a["weeks"] += last
                    if won:
                        a["wins"] += 1
                        a["equity"] += 1.0 / co
                        if co == 1:
                            a["sole"] += 1
        print(f"  {season}: done")

    print(f"\nPool-equity backtest — {len(test_seasons)} seasons x {args.reps} realisations")
    print("Strategy C is judged on WINNING, not on surviving.\n")
    for size in pool_sizes:
        baseline = 1.0 / size
        print(f"Pool size {size} (a random entry's fair share is {baseline*100:.1f}%)")
        print(
            f"  {'strategy':<20}{'pool win %':>12}{'prize equity %':>16}"
            f"{'± SE':>8}{'sole win %':>12}{'avg last week':>15}"
        )
        for strat in strategies:
            a = agg[(strat, size)]
            n = max(1, a["reps"])
            mean = a["equity"] / n
            # Equity per realisation is in [0,1]; this bounds its variance.
            se = math.sqrt(max(0.0, mean * (1 - mean)) / n)
            print(
                f"  {strat:<20}{a['wins']/n*100:>11.1f}%{mean*100:>15.1f}%"
                f"{se*100:>7.1f}%{a['sole']/n*100:>11.1f}%{a['weeks']/n:>15.2f}"
            )
        print(f"  (n = {agg[(strategies[0], size)]['reps']} pool realisations per strategy)")
        print()

    print(
        "READ THE STANDARD ERRORS BEFORE READING THE MEANS.\n"
        "\n"
        "At default settings this backtest is underpowered: a few dozen pool realisations put the\n"
        "standard error on prize equity in the same range as the gaps between strategies, so it\n"
        "cannot separate them. Raise --reps (and --inner-sims, which controls how noisily strategy C\n"
        "makes each decision) before drawing conclusions.\n"
        "\n"
        "Two further caveats. The synthetic field is a softmax over win probability, not a real\n"
        "pool, and at a low --temperature it concentrates hard on chalk. And strategy C runs a\n"
        "nested simulation with a much smaller budget than the app uses, so it is a lower bound on\n"
        "the app's behaviour, not a measurement of it.\n"
        "\n"
        "The sharper validation of the mechanism is tests/gt-tournament.test.ts, which checks the\n"
        "simulator against synthetic pools whose correct answer is analytically known."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
