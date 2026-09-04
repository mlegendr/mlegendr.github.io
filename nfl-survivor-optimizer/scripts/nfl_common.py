"""Shared helpers for the modelling scripts.

Pure standard library on purpose: `npm run train` / `npm run backtest` must work
on a clean machine with nothing but Python 3.9+ installed. The datasets involved
(~7k games, ~9k team-weeks per decade) are small enough that NumPy buys nothing.
"""

from __future__ import annotations

import csv
import io
import json
import math
import os
import sys
import urllib.request
from dataclasses import dataclass, field
from typing import Dict, Iterable, List, Optional, Tuple

NFLVERSE_SCHEDULE_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/schedules/games.csv"
)
NFLVERSE_TEAM_WEEK_URL = (
    "https://github.com/nflverse/nflverse-data/releases/download/stats_team/"
    "stats_team_week_{season}.csv"
)

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_DIR = os.path.join(ROOT, "data", "cache")
MODEL_DIR = os.path.join(ROOT, "data", "model")

# Relocated/renamed franchises -> the abbreviation the app uses today.
TEAM_ALIASES = {
    "OAK": "LV", "SD": "LAC", "STL": "LA", "LAR": "LA", "SDG": "LAC",
    "WSH": "WAS", "JAC": "JAX", "ARZ": "ARI", "BLT": "BAL", "CLV": "CLE",
    "HST": "HOU", "GNB": "GB", "KAN": "KC", "NOR": "NO", "NWE": "NE",
    "SFO": "SF", "TAM": "TB", "LVR": "LV",
}

TEAMS = [
    "ARI", "ATL", "BAL", "BUF", "CAR", "CHI", "CIN", "CLE", "DAL", "DEN",
    "DET", "GB", "HOU", "IND", "JAX", "KC", "LA", "LAC", "LV", "MIA",
    "MIN", "NE", "NO", "NYG", "NYJ", "PHI", "PIT", "SEA", "SF", "TB",
    "TEN", "WAS",
]


def norm_team(raw: Optional[str]) -> Optional[str]:
    if not raw:
        return None
    t = raw.strip().upper()
    t = TEAM_ALIASES.get(t, t)
    return t if t in TEAMS else None


def _download(url: str, cache_name: str, max_age_s: int = 6 * 3600) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = os.path.join(CACHE_DIR, cache_name)
    if os.path.exists(path):
        age = os.path.getmtime(path)
        import time

        if time.time() - age < max_age_s:
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
    try:
        with urllib.request.urlopen(url, timeout=180) as resp:
            text = resp.read().decode("utf-8", errors="replace")
    except Exception as exc:  # pragma: no cover - network path
        if os.path.exists(path):
            sys.stderr.write(f"[warn] {url} failed ({exc}); using cached copy\n")
            with open(path, "r", encoding="utf-8") as fh:
                return fh.read()
        raise
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(text)
    return text


def _f(row: dict, key: str) -> Optional[float]:
    v = (row.get(key) or "").strip()
    if v == "" or v.upper() == "NA":
        return None
    try:
        return float(v)
    except ValueError:
        return None


@dataclass
class Game:
    game_id: str
    season: int
    week: int
    game_type: str
    gameday: str
    home: str
    away: str
    home_score: Optional[float]
    away_score: Optional[float]
    neutral: bool
    div_game: bool
    home_rest: Optional[float]
    away_rest: Optional[float]
    home_ml: Optional[float]
    away_ml: Optional[float]
    spread_line: Optional[float]
    roof: str

    @property
    def completed(self) -> bool:
        return self.home_score is not None and self.away_score is not None

    @property
    def home_won(self) -> Optional[int]:
        if not self.completed:
            return None
        if self.home_score == self.away_score:
            return None  # ties handled explicitly by callers
        return 1 if self.home_score > self.away_score else 0

    @property
    def tie(self) -> bool:
        return self.completed and self.home_score == self.away_score


def load_games(seasons: Iterable[int], game_type: str = "REG") -> List[Game]:
    text = _download(NFLVERSE_SCHEDULE_URL, "games.csv")
    wanted = set(seasons)
    out: List[Game] = []
    for row in csv.DictReader(io.StringIO(text)):
        try:
            season = int(row["season"])
        except (KeyError, ValueError):
            continue
        if season not in wanted:
            continue
        if game_type and (row.get("game_type") or "") != game_type:
            continue
        home = norm_team(row.get("home_team"))
        away = norm_team(row.get("away_team"))
        if not home or not away:
            continue
        out.append(
            Game(
                game_id=row["game_id"],
                season=season,
                week=int(float(row.get("week") or 0)),
                game_type=row.get("game_type") or "REG",
                gameday=row.get("gameday") or "",
                home=home,
                away=away,
                home_score=_f(row, "home_score"),
                away_score=_f(row, "away_score"),
                neutral=(row.get("location") or "Home").strip().lower() == "neutral",
                div_game=(row.get("div_game") or "0").strip() in ("1", "1.0", "TRUE", "True"),
                home_rest=_f(row, "home_rest"),
                away_rest=_f(row, "away_rest"),
                home_ml=_f(row, "home_moneyline"),
                away_ml=_f(row, "away_moneyline"),
                spread_line=_f(row, "spread_line"),
                roof=(row.get("roof") or "").strip(),
            )
        )
    out.sort(key=lambda g: (g.gameday, g.game_id))
    return out


@dataclass
class TeamWeek:
    season: int
    week: int
    team: str
    opponent: str
    off_epa: float
    plays: float


def load_team_weeks(seasons: Iterable[int]) -> List[TeamWeek]:
    out: List[TeamWeek] = []
    for season in seasons:
        try:
            text = _download(
                NFLVERSE_TEAM_WEEK_URL.format(season=season),
                f"stats_team_week_{season}.csv",
                max_age_s=6 * 3600,
            )
        except Exception as exc:  # pragma: no cover - network path
            sys.stderr.write(f"[warn] team stats for {season} unavailable: {exc}\n")
            continue
        for row in csv.DictReader(io.StringIO(text)):
            if (row.get("season_type") or "REG") != "REG":
                continue
            team = norm_team(row.get("team"))
            opp = norm_team(row.get("opponent_team"))
            if not team or not opp:
                continue
            pass_epa = _f(row, "passing_epa") or 0.0
            rush_epa = _f(row, "rushing_epa") or 0.0
            attempts = _f(row, "attempts") or 0.0
            sacks = _f(row, "sacks_suffered") or 0.0
            carries = _f(row, "carries") or 0.0
            plays = attempts + sacks + carries
            if plays < 20:
                continue
            out.append(
                TeamWeek(
                    season=season,
                    week=int(float(row.get("week") or 0)),
                    team=team,
                    opponent=opp,
                    off_epa=(pass_epa + rush_epa) / plays,
                    plays=plays,
                )
            )
    return out


# --------------------------------------------------------------------------- #
# Elo
# --------------------------------------------------------------------------- #


@dataclass
class EloConfig:
    k: float = 20.0
    home_field: float = 48.0
    rest_per_day: float = 1.6
    mov_scale: float = 0.001
    revert: float = 0.28  # fraction pulled back to 1500 between seasons
    base: float = 1500.0


class EloModel:
    """Standard 538-style NFL Elo with margin-of-victory damping."""

    def __init__(self, cfg: EloConfig):
        self.cfg = cfg
        self.ratings: Dict[str, float] = {t: cfg.base for t in TEAMS}
        self.games_played: Dict[str, int] = {t: 0 for t in TEAMS}
        self.season: Optional[int] = None

    def start_season(self, season: int) -> None:
        if self.season is not None and season != self.season:
            for t in self.ratings:
                self.ratings[t] = self.cfg.base + (self.ratings[t] - self.cfg.base) * (
                    1 - self.cfg.revert
                )
                self.games_played[t] = 0
        self.season = season

    def pregame_diff(self, game: Game) -> float:
        cfg = self.cfg
        diff = self.ratings[game.home] - self.ratings[game.away]
        if not game.neutral:
            diff += cfg.home_field
        hr, ar = game.home_rest, game.away_rest
        if hr is not None and ar is not None:
            diff += cfg.rest_per_day * max(-10.0, min(10.0, hr - ar))
        return diff

    def expected_home(self, game: Game) -> float:
        return 1.0 / (1.0 + 10 ** (-self.pregame_diff(game) / 400.0))

    def update(self, game: Game) -> None:
        if not game.completed:
            return
        exp_home = self.expected_home(game)
        margin = (game.home_score or 0) - (game.away_score or 0)
        actual = 0.5 if margin == 0 else (1.0 if margin > 0 else 0.0)
        # Damp blowouts and correct for the favourite's inflated margins.
        elo_diff = self.pregame_diff(game)
        mov_mult = math.log(abs(margin) + 1.0) * (
            2.2 / ((elo_diff if margin > 0 else -elo_diff) * self.cfg.mov_scale + 2.2)
        )
        shift = self.cfg.k * mov_mult * (actual - exp_home)
        self.ratings[game.home] += shift
        self.ratings[game.away] -= shift
        self.games_played[game.home] += 1
        self.games_played[game.away] += 1

    def snapshot(self) -> Dict[str, float]:
        return dict(self.ratings)


# --------------------------------------------------------------------------- #
# EPA tracking (exponentially weighted, with previous-season carryover)
# --------------------------------------------------------------------------- #


@dataclass
class EpaTracker:
    """Exponentially weighted offensive/defensive EPA per play, updated per game.

    `alpha` is the weight on the newest game; `carryover` is how much of the
    previous season's final value survives into the next season's prior. Both
    exist to stop the model treating one Week 1 result as revealed truth.
    """

    alpha: float = 0.22
    carryover: float = 0.55
    off: Dict[str, float] = field(default_factory=lambda: {t: 0.0 for t in TEAMS})
    deff: Dict[str, float] = field(default_factory=lambda: {t: 0.0 for t in TEAMS})
    n: Dict[str, int] = field(default_factory=lambda: {t: 0 for t in TEAMS})

    def start_season(self) -> None:
        for t in TEAMS:
            self.off[t] *= self.carryover
            self.deff[t] *= self.carryover
            self.n[t] = 0

    def observe(self, team: str, opponent: str, off_epa: float) -> None:
        self.off[team] = (1 - self.alpha) * self.off[team] + self.alpha * off_epa
        self.deff[opponent] = (1 - self.alpha) * self.deff[opponent] + self.alpha * off_epa
        self.n[team] += 1

    def net_edge(self, home: str, away: str) -> float:
        """Home team's expected EPA/play edge: (its offence vs their defence) minus the mirror."""
        home_side = self.off[home] - self.deff[away]
        away_side = self.off[away] - self.deff[home]
        return home_side - away_side


# --------------------------------------------------------------------------- #
# Logistic regression (pure python, L2-regularised gradient descent)
# --------------------------------------------------------------------------- #


def sigmoid(x: float) -> float:
    if x >= 0:
        return 1.0 / (1.0 + math.exp(-x))
    e = math.exp(x)
    return e / (1.0 + e)


def fit_logistic(
    X: List[List[float]],
    y: List[float],
    l2: float = 1.0,
    iters: int = 4000,
    lr: float = 0.35,
) -> List[float]:
    """Returns [intercept, w1, ..., wk]. Adam-free plain GD is plenty here."""
    if not X:
        return [0.0]
    k = len(X[0])
    w = [0.0] * (k + 1)
    n = len(X)
    for it in range(iters):
        grad = [0.0] * (k + 1)
        for xi, yi in zip(X, y):
            z = w[0]
            for j in range(k):
                z += w[j + 1] * xi[j]
            err = sigmoid(z) - yi
            grad[0] += err
            for j in range(k):
                grad[j + 1] += err * xi[j]
        for j in range(k + 1):
            grad[j] /= n
            if j > 0:
                grad[j] += l2 * w[j] / n
        step = lr * (1.0 - 0.5 * it / iters)
        for j in range(k + 1):
            w[j] -= step * grad[j]
    return w


def predict_logistic(w: List[float], x: List[float]) -> float:
    z = w[0]
    for j, xj in enumerate(x):
        z += w[j + 1] * xj
    return sigmoid(z)


# --------------------------------------------------------------------------- #
# Metrics
# --------------------------------------------------------------------------- #


def brier(preds: List[float], actual: List[float]) -> float:
    if not preds:
        return float("nan")
    return sum((p - a) ** 2 for p, a in zip(preds, actual)) / len(preds)


def log_loss(preds: List[float], actual: List[float]) -> float:
    if not preds:
        return float("nan")
    eps = 1e-12
    total = 0.0
    for p, a in zip(preds, actual):
        q = min(1 - eps, max(eps, p))
        total += -(a * math.log(q) + (1 - a) * math.log(1 - q))
    return total / len(preds)


def accuracy(preds: List[float], actual: List[float]) -> float:
    if not preds:
        return float("nan")
    hits = sum(1 for p, a in zip(preds, actual) if (p >= 0.5) == (a >= 0.5))
    return hits / len(preds)


CAL_BINS = [(0.5, 0.55), (0.55, 0.6), (0.6, 0.65), (0.65, 0.7), (0.7, 0.75),
            (0.75, 0.8), (0.8, 0.85), (0.85, 0.9), (0.9, 1.01)]


def calibration(preds: List[float], actual: List[float]) -> List[dict]:
    """Fold each prediction onto the favourite's side, then bin it."""
    rows = []
    for lo, hi in CAL_BINS:
        ps, acts = [], []
        for p, a in zip(preds, actual):
            fav_p = p if p >= 0.5 else 1 - p
            fav_a = a if p >= 0.5 else 1 - a
            if lo <= fav_p < hi:
                ps.append(fav_p)
                acts.append(fav_a)
        rows.append(
            {
                "bin": f"{int(lo*100)}-{int(hi*100 if hi <= 1 else 100)}%",
                "n": len(ps),
                "predicted": (sum(ps) / len(ps)) if ps else None,
                "actual": (sum(acts) / len(acts)) if acts else None,
            }
        )
    return rows


def american_to_prob(ml: float) -> float:
    return 100.0 / (ml + 100.0) if ml > 0 else (-ml) / ((-ml) + 100.0)


def devig(home_ml: Optional[float], away_ml: Optional[float]) -> Optional[float]:
    """Fair home win probability with the vig removed, or None."""
    if home_ml is None or away_ml is None:
        return None
    try:
        rh = american_to_prob(home_ml)
        ra = american_to_prob(away_ml)
    except (ValueError, ZeroDivisionError):
        return None
    total = rh + ra
    if total <= 0:
        return None
    return rh / total


def write_json(path: str, payload: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2, sort_keys=False)
        fh.write("\n")
