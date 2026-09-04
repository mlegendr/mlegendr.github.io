# NFL Survivor Optimizer

A local, browser-based optimizer for a standard **Survivor / Last Man Standing** NFL pool
(2026 regular season by default).

You pick one team per week. If it wins you survive. **A team can only ever be used once.** The
app's job is not to tell you who is most likely to win this week — it is to tell you which pick
maximises your probability of surviving *the rest of the season*, which is a different and much
harder question.

Everything runs on your machine. Pool state lives in a local SQLite file. Third-party API keys are
read server-side only and never reach browser JavaScript.

---

## Table of contents

- [What the app does](#what-the-app-does)
- [Why the highest win probability is not always the right pick](#why-the-highest-win-probability-is-not-always-the-right-pick)
- [How the survivor optimizer works](#how-the-survivor-optimizer-works)
- [Data sources](#data-sources)
- [Installation](#installation)
- [Running locally](#running-locally)
- [API setup](#api-setup)
- [Database behaviour](#database-behaviour)
- [Refreshing data](#refreshing-data)
- [Model training](#model-training)
- [Backtesting](#backtesting)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Project layout](#project-layout)
- [HTTP API](#http-api)
- [Known limitations](#known-limitations)

---

## What the app does

**Dashboard**

- A prominent **weekly recommendation** card showing current win probability, the market
  probability, the model probability, the optimised path survival for your chosen horizon, and the
  full-season path survival — plus a robustness rating.
- A plain-English **explanation** ("Why Dallas?" / "Why not Buffalo?") that separates *facts*
  (a posted line, a home game, an official OUT) from *model estimates* and *uncertain assumptions*.
- A sortable **rankings table** for all 32 teams, with previously used, bye-week and
  already-kicked-off teams greyed out and labelled with the reason.
- A **season heatmap** (32 rows × 18 weeks) of predicted win probability, with the optimiser's
  planned path overlaid — this is the view that makes "save Buffalo for weeks 8–11" obvious.
- A **path planner** showing the optimal remaining sequence and cumulative survival probability,
  clearly marked as a plan rather than a commitment.
- **Injury impact**, **data status** (per provider, with freshness and DEGRADED flags),
  **pick history**, **Monte Carlo robustness**, and an optional **pool strategy** (leverage) mode.

**Other pages**

- `/history` — every recorded selection, with results graded from final scores.
- `/model` — the trained artifact's provenance, hold-out metrics and calibration table.
- `/settings` — pool rules, provider selection, manual overrides and manual injuries.

---

## Why the highest win probability is not always the right pick

Because each team can be used only once, spending a team has a **cost**: you can never use it
again. The right way to price that cost is to ask what the rest of your season looks like *after*
the pick.

A worked example the app produces routinely:

```
Team A   88% this week   ...but also 92% in Week 2 against a terrible opponent
Team B   84% this week   ...and only 60% in Week 2

Take A now  ->  you are forced into B in Week 2  ->  0.88 x 0.60 = 52.8%
Take B now  ->  A is still available in Week 2   ->  0.84 x 0.92 = 77.3%
```

Giving up 4 percentage points of safety this week buys 24 points of two-week survival. The
optimizer finds this automatically, and the explanation engine says so in words. (This exact case
is `tests/survivor.test.ts` → *"prefers the slightly less safe team now when that preserves a
strong future"*.)

The mirror case matters just as much: when taking the safest team now genuinely *is* optimal, the
optimizer must say so rather than being contrarian for its own sake. That is also a test.

---

## How the survivor optimizer works

### The objective

Let `p(team, week)` be the estimated probability that a team wins its game that week. The
probability of surviving a proposed path is the product of its weekly probabilities:

```
P(path) = prod_w p(team_w, w)
```

We optimise the log to avoid underflow:

```
maximise  sum_w log p(team_w, w)
```

subject to: exactly one team per week; each team used at most once; the team actually plays that
week; the team has not already been used.

### The solver

That is a **bipartite min-cost assignment problem** — weeks on one side, teams on the other, with
an edge wherever a team legally plays that week and cost `-log p`. It is solved **exactly** by
min-cost max-flow (successive shortest paths with Johnson potentials and Dijkstra) in
`src/lib/optimizer/assignment.ts`.

**No greedy heuristic is used anywhere.** Greedy "take the best team each week" is precisely the
failure mode this app exists to avoid, and `tests/assignment.test.ts` contains a case where greedy
gives the wrong answer.

Because every cost is `-log p >= 0`, Dijkstra is valid and the whole 18×32 problem solves in
single-digit milliseconds.

### Evaluating a current-week candidate

For **every** legal team this week:

1. Force it as this week's pick.
2. Remove it from availability in every future week.
3. Re-solve the assignment over the remaining horizon.
4. Read off the resulting optimised path survival probability.
5. Rank candidates by that, not by this week's win probability.

The dashboard exposes, for each candidate: current win %, market %, model %, **future value cost**
(season log-probability given up by spending the team now), 3/6/9-week and season path survival,
and a 0–100 recommendation score relative to the unconstrained optimum.

### Horizons

The optimiser is run at **3, 6, 9 weeks and rest-of-season**. The default recommendation emphasises
a medium horizon (6 weeks) — far enough that the no-repeat constraint bites, near enough that the
probabilities are worth trusting — while always showing the season-long result. When the four
horizons agree, that agreement is itself reported as robustness; when they disagree, the app says
so instead of hiding it.

### Robustness (Monte Carlo)

`src/lib/optimizer/montecarlo.ts` perturbs the *uncertain* parts of the forecast — future weeks far
more than a fresh current-week market, model-only games far more than a deep multi-book consensus —
using correlated team-level shocks plus per-game noise, then re-solves the optimiser 1,000–5,000
times and reports the share of scenarios in which each team is the correct pick:

```
Recommendation Robustness
DAL   61%
BAL   25%
BUF    9%
SF     5%
```

**This is not a win probability.** It is the share of plausible worlds in which that pick is right.
It is deterministic for a fixed seed.

### Probabilities that feed the optimizer

For a **current-week** game with a usable market:

```
P_final = w_market * P_market + (1 - w_market) * P_model
```

`w_market` is not arbitrary. It starts from a value calibrated by `scripts/backtest.py`, rises with
the number of sportsbooks, and falls with staleness (36-hour half-life), single-book "consensus",
and cross-book dispersion. With no market at all, the model carries the whole estimate.

For **future weeks**, sportsbook odds usually do not exist, so the internal model is used and the
result is shrunk toward 50% by ~2.2% per week (capped at 34%). A Week 15 estimate made in Week 1
must never be displayed with the confidence of a live market price, and the confidence score falls
with the horizon accordingly.

Market, model and final probabilities are all shown separately, everywhere.

### Injuries are not double-counted

If a starting quarterback is ruled out and the sportsbooks have already moved, adding another large
quarterback penalty on top of the market **counts the same information twice**. So:

- Injuries are always applied to the *model* (the model has no roster knowledge).
- An injury adjustment is applied to the *blend* only when the newest injury observation is **newer
  than the newest sportsbook update** — and then only at 35% strength, with confidence reduced.
- Otherwise the app explicitly says "Injuries already priced".

See `shouldApplyInjuryAdjustment` in `src/lib/injuries.ts` and its tests.

---

## Data sources

Everything external is reached through a provider interface (`src/lib/providers/`) and normalised
into canonical objects. Swapping a provider is a one-file change; nothing outside that directory
knows where a number came from.

| Domain | Provider | Key required | Fallback |
| --- | --- | --- | --- |
| Schedule, results, rest days, roof/surface | [nflverse](https://github.com/nflverse/nflverse-data) `schedules/games.csv` | no | cached copy in SQLite |
| Team EPA per week | nflverse `stats_team/stats_team_week_{season}.csv` | no | preseason priors only |
| Live betting market | [The Odds API](https://the-odds-api.com) (`americanfootball_nfl`, `us`, `h2h,spreads,totals`) | `ODDS_API_KEY` | the reference moneylines shipped in the nflverse schedule, marked **DEGRADED** |
| Injuries | [SportsDataIO](https://sportsdata.io) (weekly report + depth charts) | `SPORTSDATAIO_API_KEY` | [Sleeper](https://docs.sleeper.com) player database, then manual entry |
| Weather | [Open-Meteo](https://open-meteo.com) | no | none — beyond the 15-day window weather is reported *unavailable*, never invented |

**Team normalisation.** Every external string goes through `normalizeTeam()` first, so `KC`,
`Kansas City Chiefs`, `Kansas City`, `KAN`, and historical abbreviations (`OAK`→`LV`, `SD`→`LAC`,
`STL`/`LAR`→`LA`, `WSH`→`WAS`, `JAC`→`JAX`) all resolve to one canonical abbreviation. Ambiguous
input ("New York") returns `null` rather than guessing — a silent wrong join is far worse than a
visible miss.

**Bye weeks** are inferred from the schedule exactly as the league defines them: a team with no
regular-season game in a week is on bye. There is no separate bye feed to go stale.

**nflverse is deliberately not used for 2026 injuries** — its injury feed is not maintained for
seasons after 2024.

Every observation is stored with a timestamp, and every recommendation exposes `lastUpdated`,
`source` and `dataQuality`.

---

## Installation

Requirements: **Node.js 20+** (22 recommended) and **Python 3.9+** (only for training/backtesting;
the app itself does not need it).

```bash
git clone <this repo>
cd nfl-survivor-optimizer
npm install
```

`npm install` needs no API keys and downloads no browsers.

There is no manual configuration step: the first command that touches the database
(`npm run dev`, `npm run build`, `npm test`, any `db:*` script) creates `.env` from
`.env.example` if it does not already exist. That file is required — the Prisma CLI reads
`DATABASE_URL` from it and fails with `P1012: Environment variable not found: DATABASE_URL`
without it — but every API key inside it is optional. An existing `.env` is never overwritten.

---

## Running locally

```bash
npm run dev
```

Then open <http://localhost:3000>.

The first `npm run dev` automatically generates the Prisma client, creates `prisma/dev.db`, and —
if the database is empty — downloads the current season's schedule from nflverse. Subsequent runs
skip all of that.

To seed explicitly (or to re-seed a different season):

```bash
npm run db:seed
npm run db:seed -- --season 2025
npm run db:seed -- --offline     # teams and pool only, no network
```

Production build:

```bash
npm run build
npm start
```

---

## API setup

`.env` is created for you on first run (see [Installation](#installation)); if you want it
earlier, `npm run env:setup` or `cp .env.example .env` both work.

`DATABASE_URL` is required and is already filled in. Every **API key** is optional — the app runs
in a clearly-labelled reduced mode without them.

Edit `.env`:

```bash
DATABASE_URL="file:./dev.db"          # required

ODDS_API_KEY=""                       # The Odds API — live multi-book moneylines
SPORTSDATAIO_API_KEY=""               # SportsDataIO — richest injury + depth-chart feed
ENABLE_SLEEPER_FALLBACK="1"           # free injury fallback (no key)
ENABLE_WEATHER="1"                    # Open-Meteo (no key)
NFL_SEASON="2026"
APP_CLOCK=""                          # pin "now", e.g. "2026-10-14T12:00:00Z"
OFFLINE_MODE="0"                      # 1 = never make an outbound request
```

**Keys never reach the browser.** They are read only in `src/lib/env.ts`, which is imported solely
by server-side modules; `/api/settings` reports provider availability as booleans. Nothing is
stored in `localStorage`. An end-to-end test starts the server with sentinel key values and asserts
they appear in no page and no API response.

Without `ODDS_API_KEY`, the app falls back to the single reference moneyline that ships inside the
nflverse schedule, flags the odds provider **DEGRADED**, and reduces that market's blend weight.

---

## Database behaviour

SQLite via Prisma, at `prisma/dev.db`.

Models: `Team`, `Game`, `OddsSnapshot`, `WeatherSnapshot`, `InjuryReport`, `PredictionSnapshot`,
`Pool`, `Pick`, `ManualOverride`, `ProviderStatus`, `CacheEntry`, `TeamRating`.

**The one rule that matters:** a team is unavailable **if and only if** it appears on a
`confirmed` pick. A recommendation is never treated as used. Only pressing
**Confirm Week X Pick** writes that constraint, and from then on the team is excluded from every
recommendation, every future path and every heatmap cell — permanently, across browser and server
restarts.

Editing a confirmed historical pick is allowed but shows a warning, because it changes what the
optimizer believes you have already spent.

Backup and restore:

```bash
curl http://localhost:3000/api/pool/export > survivor-backup.json
curl -X POST http://localhost:3000/api/pool/import \
  -H 'content-type: application/json' \
  --data @survivor-backup.json
```

The same two actions are buttons on the dashboard's Pick History panel.

Useful commands:

```bash
npm run db:setup     # generate client + push schema
npm run db:push      # push schema only
npm run db:reset     # DESTRUCTIVE: delete dev.db, recreate, re-seed
npx prisma studio    # browse the database
```

---

## Refreshing data

Press **Refresh Data** in the header, or:

```bash
curl -X POST http://localhost:3000/api/refresh -H 'content-type: application/json' -d '{"force":true}'
```

Refresh pulls every provider in parallel, records per-provider status, and re-grades confirmed
picks against final scores. A provider that fails **degrades** — it never silently serves stale
data as if it were fresh; the Data Status panel shows the failure and the age of what is being used.

Caching is TTL-based in SQLite and tightens automatically on game day:

| Data | Normal | Game day |
| --- | --- | --- |
| Schedule | 12 h | 30 min |
| Odds | 15 min | 3 min |
| Injuries | 3 h | 20 min |
| Sleeper player database | 24 h | 24 h |
| Weather | 3 h | 45 min |
| Team stats | 6 h | 6 h |
| Historical files | 7 days | 7 days |

Set `OFFLINE_MODE=1` to forbid all outbound requests; the app then serves what is already in the
database and says so.

---

## Model training

The app needs its own football model because sportsbook odds do not exist for games many weeks out.

```bash
npm run train
# equivalently:
python3 scripts/train_model.py --start 2006 --end 2025 --holdout 3 --target-season 2026
python3 scripts/train_model.py --quick          # skip the Elo grid search (fast)
```

Writes `data/model/model.json`, which the TypeScript app loads at runtime. Pure standard-library
Python — no NumPy, pandas or scikit-learn required.

What it does:

1. Downloads nflverse schedules and weekly team EPA (cached under `data/cache/`).
2. Grid-searches Elo hyper-parameters (`k`, home-field, between-season regression) on a strictly
   chronological split.
3. Fits a logistic regression on features that were all knowable before kickoff:
   Elo differential (including home field, rest differential and neutral-site handling),
   opponent-adjusted EPA/play edge, rest differential, neutral site, division game.
4. Evaluates on held-out seasons (Brier, log loss, accuracy, calibration) and against the closing
   market where nflverse carries moneylines.
5. Exports coefficients, blend weights, horizon-shrink parameters and **per-team preseason priors**
   for the target season.

**Early-season behaviour.** Week 1 uses the previous season's end-of-year ratings regressed toward
the mean, plus the current betting market. EPA influence ramps in as `n/(n+4)` games are played, and
Elo updates as results arrive — so one Week 1 result never "reveals" a team's true strength.

**Regression to the mean.** Elo uses a damped margin-of-victory multiplier that corrects for the
favourite's inflated margins; EPA is exponentially weighted with previous-season carryover. Noisy
metrics (turnover margin, fumble recovery rate, defensive touchdown rate) are deliberately *not*
features — they do not survive a chronological backtest.

At runtime the TypeScript side (`src/lib/model/ratings.ts`) replays the current season's completed
games on top of those priors using the *same* update rules, snapshotting the ratings knowable
entering each week.

If `data/model/model.json` is missing, the app runs on documented default parameters and labels
itself **Untrained model** in the header and on `/model`.

---

## Backtesting

### Game-level (calibration)

```bash
npm run backtest
# or: python3 scripts/backtest.py --test 2022-2025 --first 2006 [--write]
```

Rolling-origin evaluation. For a game in season `S`, the coefficients are refit using only seasons
before `S`, and ratings contain only games that finished before that kickoff. **No look-ahead
leakage anywhere.** Reports Brier, log loss, accuracy, favourite upset rate, and calibration tables
(50–55%, 55–60%, … 90%+) for model, market and blend, plus a sweep of the blend weight.
`--write` updates only `blend.marketWeightBase` in the artifact.

Representative output (2024–2025, trained on 2010 onward):

```
  Model only     n=543   brier=0.2218 logloss=0.6333 acc=0.628
  Market only    n=543   brier=0.2061 logloss=0.5984 acc=0.685
  Blend w=1.00   n=543   brier=0.2061 logloss=0.5984 acc=0.685
```

The market being hard to beat is the expected result, and is exactly why it anchors current-week
probabilities here. The sweep prefers a market weight near 1.0 *against closing lines*; the app
caps it lower (0.92) because it runs against mid-week lines that can be thin or stale, and because
the model must still carry games with no market at all.

Calibration is reported prominently because it matters more here than accuracy: the optimizer
multiplies probability *magnitudes*, so a model that says 80% when it means 70% produces
confidently wrong paths.

### Survivor-level (does saving teams actually help?)

```bash
npm run survivor-backtest
# or: python3 scripts/survivor_backtest.py --seasons 2019-2025 --sims 150 --horizon 6
```

Compares three strategies, all obeying the one-use-per-team constraint:

- **A — largest favourite**: highest de-vigged market probability available.
- **B — highest model probability**.
- **C — path optimizer**: exact no-repeat assignment, re-solved every week.

Reports average survival week, P(reach Week 10), P(reach Week 14) and P(survive the regular
season), both on actual history and via Monte Carlo over the market's own distribution. Sample
output (2022–2025, 120 sims/season):

```
Monte Carlo (outcomes drawn from the market)
  strategy              avg week  reach W10  reach W14  survived
  largest-favourite         3.50       9.4%       2.5%      1.0%
  highest-model             3.65       9.2%       3.1%      1.2%
  optimizer                 3.97      11.7%       4.6%      1.7%
```

The optimizer wins, which is the point — but note the absolute numbers. Surviving a full NFL
regular season is genuinely a ~1–3% proposition for anyone. Anything claiming otherwise is selling
something. (Runtime is a few minutes; the historical rows are single trajectories per season and
are dominated by luck.)

---

## Testing

```bash
npm test          # Vitest unit + integration (143 tests)
npm run test:e2e  # Playwright end-to-end (10 tests)
npm run verify    # typecheck + unit tests + production build
```

Unit and integration coverage includes:

- **Survivor rules** — a previously used team is never recommended; a bye team is never
  recommended; a team with no scheduled game is never recommended; a path never reuses a team;
  every week gets exactly one team when a feasible solution exists; infeasibility is reported
  rather than hidden.
- **Optimizer behaviour** — the "safest now but valuable later" case resolves to the *other* team,
  **and** the case where taking the safest team now really is optimal.
- **Probability maths** — American moneyline conversion, vig removal summing to exactly one,
  multi-book consensus (median, one-sided books ignored, dispersion), everything inside [0,1].
- **Injury layer** — position/depth/status weighting, diminishing returns, and the
  double-counting guard against a fresher market.
- **Persistence** — confirmed picks survive a simulated restart and stay excluded; unconfirmed
  picks are *not* treated as used; grading honours the tie rule; export/import round-trips.
- **Providers** — nflverse CSV parsing (including ET→UTC kickoffs and neutral sites), The Odds API
  event joining and de-vigging, SportsDataIO and Sleeper mapping, weather eligibility.

End-to-end tests run against a **separate database** (`prisma/e2e.db`) so they can never touch your
pool, and assert that sentinel API-key values never reach the browser.

If your environment ships its own Chromium instead of the build Playwright would download:

```bash
PLAYWRIGHT_CHROMIUM_PATH=/path/to/chrome npm run test:e2e
```

---

## Project layout

```
prisma/schema.prisma            SQLite schema
data/model/model.json           trained model artifact (produced by npm run train)
scripts/
  train_model.py                training pipeline
  backtest.py                   rolling-origin calibration backtest
  survivor_backtest.py          strategy comparison
  nfl_common.py                 shared Elo / EPA / metrics (stdlib only)
  seed.ts                       explicit seeding
  ensure-seeded.ts              first-run bootstrap for npm run dev
src/lib/
  teams.ts                      canonical 32-team registry + normalisation
  probability.ts                moneyline maths, vig removal, consensus
  optimizer/assignment.ts       exact min-cost max-flow assignment
  optimizer/survivor.ts         path optimisation and candidate evaluation
  optimizer/montecarlo.ts       recommendation robustness
  model/                        artifact loading, ratings replay, prediction
  providers/                    schedule / odds / injury / weather / stats adapters
  engine.ts                     assembles one analysis snapshot for the UI
  explain.ts                    explanation engine
  pool.ts, overrides.ts         pool state and manual overrides
src/app/                        Next.js App Router pages and API routes
src/components/                 dashboard UI (shadcn-style primitives in ui/)
tests/                          Vitest
e2e/                            Playwright
```

`src/components/ui/` contains hand-written shadcn/ui-style primitives (same API and Tailwind
conventions) rather than components pulled in by the shadcn CLI, so the project installs with no
network access and no Radix runtime.

---

## HTTP API

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/api/health` | counts and offline flag |
| GET | `/api/analysis?horizon=6&robustness=1` | the full dashboard snapshot |
| POST | `/api/refresh` | refresh every provider, re-grade picks |
| GET/POST/DELETE | `/api/picks` | list, confirm and remove picks |
| GET/PATCH | `/api/settings` | pool rules (provider availability as booleans only) |
| GET/POST/DELETE | `/api/overrides` | manual win probability / spread / moneyline / current week |
| GET/POST/DELETE | `/api/injuries` | manual injury entry |
| POST | `/api/robustness` | Monte Carlo on demand |
| POST | `/api/pool-strategy` | optional leverage mode |
| GET | `/api/pool/export` · POST `/api/pool/import` | JSON backup |

`POST /api/picks` refuses a team that is already confirmed elsewhere, and refuses to confirm a game
that has already kicked off unless you pass `"force": true`.

---

## Troubleshooting

### `Cannot find native binding` when the page loads

```
Error: Cannot find native binding. npm has a bug related to optional dependencies
(https://github.com/npm/cli/issues/4828)
./src/app/globals.css ... postcss-loader ...
```

Tailwind v4 compiles CSS through a native Rust binary (`@tailwindcss/oxide`, plus
`lightningcss`), shipped as one optional dependency per platform. npm sometimes skips
installing the one for your machine — a long-standing npm bug, not a missing lockfile entry
(`package-lock.json` here contains all of them, macOS arm64/x64 included).

```bash
rm -rf node_modules package-lock.json .next
npm install
npm run dev
```

Deleting `.next` matters: the failed CSS build is cached there and will be replayed otherwise.
If it still fails, `npm cache clean --force` and repeat.

### `P1012: Environment variable not found: DATABASE_URL`

You are on a version from before `.env` was created automatically. Either pull the latest, or:

```bash
cp .env.example .env
```

The Prisma CLI reads `DATABASE_URL` from `.env` directly — it does not use Next.js's env
loading — so it fails before the app starts.

### `No 2026 games in the database`

Seeding never ran or had no network:

```bash
npm run db:seed
```

Add `-- --offline` to set up teams and the pool without any network call.

### Port 3000 already in use

```bash
npx next dev -p 3001
```

### Everything is labelled DEGRADED

Expected with no API keys: the odds provider falls back to the single reference line in the
schedule, and injuries fall back to Sleeper or to nothing. See [API setup](#api-setup). The app
is fully usable in this state — it just says so rather than pretending the data is fresh.

---

## Known limitations

- **Probabilities are estimates.** The model's hold-out Brier score is ~0.222 against the market's
  ~0.206. The market is better, which is why it anchors current-week numbers. Nothing here is an
  edge over sportsbooks.
- **Far-future probabilities are weak.** A Week 15 forecast made in Week 1 knows nothing about
  injuries, trades or coaching changes. It is shrunk toward 50% and its confidence is reduced, but
  it is still a guess. Treat the path beyond ~6 weeks as a planning aid, not a schedule.
- **The path is not a commitment.** It is recomputed every week. Only confirmed picks are binding.
- **Injury impact is estimated, not measured.** Position priors and depth-chart weighting are
  reasonable, not authoritative. "Starting QB out ≈ 0.9 logits" is anchored to historical market
  movement, but individual cases vary enormously.
- **Sleeper has no weekly injury report.** Designations from the fallback can lag the official
  Wednesday/Friday reports. Prefer SportsDataIO when it matters, or use manual overrides.
- **Weather beyond ~15 days is unavailable**, not estimated. Retractable roofs with no stated state
  are treated as open, which is the conservative choice.
- **Pick popularity is never invented.** Pool Strategy mode requires your own estimates and says so.
- **Ties.** Default pool rule is tie = loss, configurable in Settings.
- **One pool at a time in the UI.** The schema supports multiple `Pool` rows; the interface uses
  the active one.
- **Postseason support is minimal.** The default and the tested path is the 18-week regular season.
- **This is not gambling advice.** It is an optimizer over your own probability estimates.
