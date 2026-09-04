#!/usr/bin/env python3
"""Historical survivor simulation: does preserving future team value actually help?

    python3 scripts/survivor_backtest.py [--seasons 2015-2025] [--sims 400]

Strategies compared, all obeying the one-use-per-team constraint:

  A  largest-favourite   pick the highest de-vigged market probability available
  B  highest-model       pick the highest model probability available
  C  path-optimizer      solve the exact no-repeat assignment over the remaining
                         weeks and take its week-1 choice, re-solving every week

Two evaluations are reported:

  * Actual history — replay the real results. One trajectory per season, so the
    sample is small and the numbers are noisy; they are shown because they are
    what really happened.
  * Monte Carlo — sample outcomes from the de-vigged closing market for each
    game, many times per season. This gives the smooth estimates the task asks
    for (average survival week, P(reach week 10), P(reach week 14), P(survive)).

Probabilities used by the strategies are always the *pre-kickoff* ones: the
market close for that game and a model refit on strictly earlier seasons.
"""

from __future__ import annotations

import argparse
import math
import os
import random
import sys
from collections import defaultdict

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from nfl_common import (  # noqa: E402
    EloConfig,
    EloModel,
    EpaTracker,
    Game,
    devig,
    fit_logistic,
    load_games,
    load_team_weeks,
    predict_logistic,
)

# --------------------------------------------------------------------------- #
# Min-cost max-flow assignment (mirrors src/lib/optimizer/assignment.ts)
# --------------------------------------------------------------------------- #


class MinCostFlow:
    def __init__(self, n: int):
        self.n = n
        self.graph: list[list[list]] = [[] for _ in range(n)]

    def add(self, u: int, v: int, cap: float, cost: float) -> None:
        self.graph[u].append([v, cap, cost, len(self.graph[v])])
        self.graph[v].append([u, 0.0, -cost, len(self.graph[u]) - 1])

    def run(self, s: int, t: int, maxf: float):
        n = self.n
        pot = [0.0] * n
        flow = 0.0
        cost = 0.0
        INF = float("inf")
        while flow < maxf:
            dist = [INF] * n
            prevv = [-1] * n
            preve = [-1] * n
            dist[s] = 0.0
            visited = [False] * n
            while True:
                u = -1
                best = INF
                for i in range(n):
                    if not visited[i] and dist[i] < best:
                        best, u = dist[i], i
                if u == -1:
                    break
                visited[u] = True
                for ei, e in enumerate(self.graph[u]):
                    v, cap, c, _ = e
                    if cap <= 1e-12:
                        continue
                    nd = dist[u] + c + pot[u] - pot[v]
                    if nd < dist[v] - 1e-12:
                        dist[v] = nd
                        prevv[v] = u
                        preve[v] = ei
            if dist[t] == INF:
                break
            for i in range(n):
                if dist[i] < INF:
                    pot[i] += dist[i]
            d = maxf - flow
            v = t
            while v != s:
                d = min(d, self.graph[prevv[v]][preve[v]][1])
                v = prevv[v]
            v = t
            while v != s:
                e = self.graph[prevv[v]][preve[v]]
                e[1] -= d
                self.graph[v][e[3]][1] += d
                cost += d * e[2]
                v = prevv[v]
            flow += d
        return flow, cost

    def chosen(self, node: int, lo: int, hi: int):
        for v, cap, _c, rev in self.graph[node]:
            if lo <= v < hi and self.graph[v][rev][1] > 0.5:
                return v - lo
        return None


def optimal_first_pick(prob_by_week: dict, weeks: list[int], available: set[str]):
    """Solve the no-repeat assignment over `weeks`; return the team chosen for weeks[0]."""
    teams = sorted({t for w in weeks for t in prob_by_week.get(w, {}) if t in available})
    if not teams or not weeks:
        return None
    ti = {t: i for i, t in enumerate(teams)}
    src, wbase = 0, 1
    tbase = wbase + len(weeks)
    snk = tbase + len(teams)
    mcf = MinCostFlow(snk + 1)
    for i in range(len(weeks)):
        mcf.add(src, wbase + i, 1.0, 0.0)
    for i in range(len(teams)):
        mcf.add(tbase + i, snk, 1.0, 0.0)
    for wi, w in enumerate(weeks):
        for team, p in prob_by_week.get(w, {}).items():
            if team not in ti:
                continue
            mcf.add(wbase + wi, tbase + ti[team], 1.0, -math.log(max(p, 1e-9)))
    mcf.run(src, snk, float(len(weeks)))
    idx = mcf.chosen(wbase, tbase, snk)
    return teams[idx] if idx is not None else None


# --------------------------------------------------------------------------- #
# Season preparation
# --------------------------------------------------------------------------- #


def features_for(elo: EloModel, epa: EpaTracker, g: Game) -> list[float]:
    experience = min(epa.n[g.home], epa.n[g.away])
    rest_diff = 0.0
    if g.home_rest is not None and g.away_rest is not None:
        rest_diff = max(-10.0, min(10.0, g.home_rest - g.away_rest))
    return [
        elo.pregame_diff(g) / 100.0,
        epa.net_edge(g.home, g.away) * (experience / (experience + 4.0)) * 10.0,
        rest_diff / 7.0,
        1.0 if g.neutral else 0.0,
        1.0 if g.div_game else 0.0,
    ]


def prepare_season(games, tw_index, season, coeffs, cfg):
    """Return market/model probabilities and actual results for every team-week."""
    elo = EloModel(cfg)
    epa = EpaTracker()
    prior_season = None
    prior_week = None
    market: dict[int, dict[str, float]] = defaultdict(dict)
    model: dict[int, dict[str, float]] = defaultdict(dict)
    won: dict[int, dict[str, bool]] = defaultdict(dict)

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

        if g.season == season:
            p_model = predict_logistic(coeffs, features_for(elo, epa, g))
            p_market = devig(g.home_ml, g.away_ml)
            model[g.week][g.home] = p_model
            model[g.week][g.away] = 1 - p_model
            if p_market is not None:
                market[g.week][g.home] = p_market
                market[g.week][g.away] = 1 - p_market
            if g.completed:
                # A tie eliminates, matching the app's default pool rule.
                won[g.week][g.home] = (g.home_score or 0) > (g.away_score or 0)
                won[g.week][g.away] = (g.away_score or 0) > (g.home_score or 0)
        elo.update(g)

    return market, model, won


def blended(market, model, weeks, w=0.8):
    """The probabilities the app itself would use: market-anchored, model fallback."""
    out: dict[int, dict[str, float]] = {}
    for wk in weeks:
        out[wk] = {}
        for team, pm in model.get(wk, {}).items():
            mk = market.get(wk, {}).get(team)
            out[wk][team] = w * mk + (1 - w) * pm if mk is not None else pm
    return out


# --------------------------------------------------------------------------- #
# Strategies
# --------------------------------------------------------------------------- #


def run_strategy(strategy, probs, weeks, outcome, horizon):
    """Returns the last week survived (weeks[-1] means survived the whole season)."""
    available = {t for wk in weeks for t in probs.get(wk, {})}
    for i, wk in enumerate(weeks):
        options = {t: p for t, p in probs.get(wk, {}).items() if t in available}
        if not options:
            return wk - 1
        if strategy == "optimizer":
            future = weeks[i : i + horizon]
            pick = optimal_first_pick(probs, future, available)
            if pick is None:
                pick = max(options, key=lambda t: options[t])
        else:
            pick = max(options, key=lambda t: options[t])
        available.discard(pick)
        if not outcome(wk, pick):
            return wk - 1
    return weeks[-1]


def summarize(results, weeks):
    n = len(results)
    if n == 0:
        return {}
    last = weeks[-1]
    return {
        "avg_week": sum(results) / n,
        "reach10": sum(1 for r in results if r >= 10) / n,
        "reach14": sum(1 for r in results if r >= 14) / n,
        "survive": sum(1 for r in results if r >= last) / n,
    }


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--seasons", default="2019-2025")
    ap.add_argument("--first", type=int, default=2006)
    ap.add_argument("--sims", type=int, default=150)
    ap.add_argument("--horizon", type=int, default=6)
    ap.add_argument("--seed", type=int, default=20260101)
    args = ap.parse_args()

    lo, hi = (args.seasons.split("-") + [args.seasons])[:2]
    test_seasons = list(range(int(lo), int(hi) + 1))
    all_seasons = list(range(args.first, test_seasons[-1] + 1))

    print(f"Loading {all_seasons[0]}-{all_seasons[-1]} ...")
    games = [g for g in load_games(all_seasons) if g.completed]
    tw_index = defaultdict(list)
    for tw in load_team_weeks(all_seasons):
        tw_index[(tw.season, tw.week)].append(tw)
    cfg = EloConfig()

    rng = random.Random(args.seed)
    strategies = ["largest-favourite", "highest-model", "optimizer"]
    hist: dict[str, list[int]] = {s: [] for s in strategies}
    mc: dict[str, list[int]] = {s: [] for s in strategies}
    weeks_seen: list[int] = []

    from backtest import replay  # reuse the leak-free replay

    for season in test_seasons:
        train_rows, _, _ = replay(games, tw_index, cfg, stop_before_season=season)
        X = [r["features"] for r in train_rows if not r["game"].tie]
        y = [float(r["game"].home_won) for r in train_rows if not r["game"].tie]
        coeffs = fit_logistic(X, y, l2=2.0, iters=1500, lr=0.4)

        market, model, won = prepare_season(games, tw_index, season, coeffs, cfg)
        weeks = sorted(w for w in model if model[w])
        if not weeks:
            continue
        weeks_seen = weeks
        blend = blended(market, model, weeks)
        market_full = {w: dict(market.get(w, {})) or dict(model.get(w, {})) for w in weeks}

        probs_for = {
            "largest-favourite": market_full,
            "highest-model": model,
            "optimizer": blend,
        }

        # ---- Actual history. -------------------------------------------------
        def real_outcome(wk, team):
            return won.get(wk, {}).get(team, False)

        for s in strategies:
            hist[s].append(run_strategy(s if s == "optimizer" else s, probs_for[s], weeks, real_outcome, args.horizon))

        # ---- Monte Carlo over the market's own distribution. -----------------
        for _ in range(args.sims):
            draw: dict[tuple[int, str], bool] = {}

            def sim_outcome(wk, team, _draw=draw, _blend=blend):
                key = (wk, team)
                if key not in _draw:
                    p = _blend.get(wk, {}).get(team, 0.5)
                    hit = rng.random() < p
                    _draw[key] = hit
                return _draw[key]

            for s in strategies:
                mc[s].append(run_strategy(s, probs_for[s], weeks, sim_outcome, args.horizon))

        print(
            f"  {season}: history -> "
            + ", ".join(f"{s}={hist[s][-1]}" for s in strategies)
        )

    print(f"\nActual historical seasons ({len(test_seasons)} seasons, one trajectory each)")
    print(f"  {'strategy':<20}{'avg week':>10}{'reach W10':>11}{'reach W14':>11}{'survived':>10}")
    for s in strategies:
        m = summarize(hist[s], weeks_seen)
        if not m:
            continue
        print(
            f"  {s:<20}{m['avg_week']:>10.2f}{m['reach10']*100:>10.1f}%"
            f"{m['reach14']*100:>10.1f}%{m['survive']*100:>9.1f}%"
        )

    print(f"\nMonte Carlo ({args.sims} sims x {len(test_seasons)} seasons, outcomes drawn from the market)")
    print(f"  {'strategy':<20}{'avg week':>10}{'reach W10':>11}{'reach W14':>11}{'survived':>10}")
    for s in strategies:
        m = summarize(mc[s], weeks_seen)
        if not m:
            continue
        print(
            f"  {s:<20}{m['avg_week']:>10.2f}{m['reach10']*100:>10.1f}%"
            f"{m['reach14']*100:>10.1f}%{m['survive']*100:>9.1f}%"
        )

    print(
        "\nRead this honestly: the historical rows are a handful of single trajectories and are\n"
        "dominated by luck. The Monte Carlo rows are the ones that actually answer whether the\n"
        "no-repeat path optimiser beats picking the biggest favourite every week."
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
