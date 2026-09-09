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
- [Multi-Entry Pool Game Theory](#multi-entry-pool-game-theory)
- [Using the pool-equity optimizer](#using-the-pool-equity-optimizer)
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

**Node.js 20.9 or newer is required** (22 LTS recommended). Check before anything else:

```bash
node -v
```

Node 18 does not merely warn — it breaks the install in a way that only shows up later. Next.js 15
refuses to start, and npm silently skips Tailwind's native binding (`@tailwindcss/oxide` declares
`engines: { node: ">= 20" }`), so the first page load dies with `Cannot find native binding`. An
`.nvmrc` is included: `nvm use` picks the right version.

Python 3.9+ is optional and only needed for training and backtesting.

Next.js is pinned to 15.x on purpose — see [Troubleshooting](#troubleshooting) before upgrading it.

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

## Multi-Entry Pool Game Theory

The survival optimizer above answers one question: *how likely am I to stay alive?* That is not the
same as *how likely am I to win this pool*, and the difference is the entire subject of this
section. Both optimizers run, both stay visible, and neither replaces the other — when they
disagree, the disagreement is itself information.

### 1. Why maximising survival is different from maximising pool victory

Survivor pools pay the last entry standing, not the entry that survived longest on average. If
eleven of your twelve rivals take Buffalo and Buffalo wins, you have survived — and gained nothing,
because so has everyone else. If Buffalo loses and you were on Denver, the pool empties and you are
close to a sole winner.

So the value of a pick depends on what everyone else picks. A 4-point sacrifice in weekly survival
can be worth it, or it can be a disaster; only simulating the tournament tells you which.

### 2. Why the app models entries, not humans

The competitive unit is a **pool entry**. One person may own several, and each carries its own
independent pick history and remaining-team inventory. Alice Entry 1 using Buffalo tells you nothing
about whether Alice Entry 2 can still use it.

The vocabulary is used consistently: *pool entry*, *opponent entry*, *active entry*, *eliminated
entry*, *entry pick*, *entry inventory*. "Player" is reserved for NFL athletes.

Your own position is itself a `PoolEntry` (`isUser = true`), kept in sync with the legacy `Pick`
table by a one-way projection — so nothing here can change what the survival optimizer sees.

### 3. How historical picks determine each entry's inventory

Import each entry's prior selections (below) and the app derives everything else:

```
remaining teams  =  all 32 NFL teams  −  teams this entry has already used
```

Elimination is computed from real results, not asserted: every entry pick is graded WIN / LOSS / TIE
against final scores, an entry is eliminated at the **first** week it lost, and the reason records
the scoreline — `Picked DAL; DAL lost to PHI 17–24`. Unusual pool rulings can be corrected by hand,
and a manual override is always labelled as one.

### 4. How opponent picks are forecast

Before the deadline you know an entry's history but not its current selection, so the app predicts a
*distribution* over the teams it can legally still use:

```
U(entry, team, week) = β1·winProbability + β2·safetyRank + β3·futureValueCost
                     + β4·scheduleScarcity + β5·publicPopularity + β6·isHome

P(team) = exp(U / temperature) / Σ exp(U / temperature)  over legal teams only
```

The coefficients are fitted by regularized multinomial logit on the pool's own observed decisions.
Hard constraints are applied *before* the softmax: a team already used by that entry, on bye, or
whose game has kicked off gets probability zero and never appears.

**Information hierarchy** (§44), highest priority first: a known current pick → hard availability
constraints → this pool's actual behaviour → entry-specific behaviour with shrinkage → current NFL
win probabilities → future team value → optional public popularity → generic priors.

### 5. Why opponent behaviour is modelled as uncertain

No opponent plays optimally, and none plays randomly. The temperature keeps every legal option at
non-zero probability, and entry-specific deviations are **shrunk toward pool-average behaviour**:

```
weight = n / (n + shrinkageStrength)     # default strength 6
```

With three observed decisions an entry keeps only a third of its own estimated deviation. That is
deliberate: fitting a personality to three picks is overfitting, and the inspector says so —
*"Entry-specific confidence: LOW — 3 decisions observed. Forecast remains anchored to pool-average
behaviour."* Descriptions are statistical (*"selected among the week's safest options in 3 of 4
observed decisions"*), never psychological.

When there is no history at all the model falls back to documented cold-start priors and labels
itself as such.

### 6–7. How NFL outcomes are simulated, and why entries on the same team are correlated

This is the correctness requirement the whole tournament rests on. Each NFL game is sampled **once
per simulated week**, and every entry that picked into that game reads the same result:

| Situation | Consequence |
| --- | --- |
| You and Entry A both pick DAL | You both advance, or you both go out. Always. |
| You pick DAL, Entry B picks NYG | Exactly one of you survives. Never both. |
| Entries A, B and C all pick BUF | A Buffalo loss eliminates all three simultaneously. |

Simulating each entry's survival independently would destroy exactly the correlation that makes pool
strategy interesting — mass elimination is the mechanism by which fading a popular team pays. All
three properties are enforced by tests (`tests/gt-correlation.test.ts`).

Game outcomes are drawn from a hash of `(seed, simIndex, week, gameIndex)` rather than a sequential
stream, so **every candidate is evaluated on identical simulated worlds**. That removes most of the
Monte Carlo noise from the *difference* between two candidates, which is the quantity you actually
care about.

### 8. What Pool Win Probability means

The fraction of simulated tournaments in which you finish among the winners — sole or shared. It is
a simulation frequency, not a score, and it is not your win probability this week.

### 9. What Expected Prize Equity means

Your expected share of the prize:

```
equity  =  1 / (number of co-winners)   in simulations you win
        =  0                            otherwise
```

### 10. How tied winners affect prize equity

| Outcome | Contribution to equity |
| --- | --- |
| 10% chance of sole victory | 10% |
| 6% chance of tying with one other entry | 3% |
| 3% chance of a three-way tie | 1% |

This is why **Expected Prize Equity is the default objective**: matching the whole field on the
chalk pick can produce a high pool win probability made almost entirely of ten-way ties. The
objective is configurable (Pool Win Probability, Sole Victory, Any Victory, Expected Prize Equity),
and if your pool plays on until exactly one entry remains there are no shared prizes, so the app
reports Pool Win Probability instead — with that rule the two coincide.

### 11. What Relative Future Value means

The survival optimizer already computes what *you* give up by spending a team. Relative future value
adds the competitive half — whether your rivals could have spent it too:

```
Opponent Access Rate = active opposing entries that can still use the team
                     / active opposing entries
```

Holding Buffalo when 8 of 10 rivals have already used it is a real asset. Holding it when all 10
still have it is not. The app reports **Inventory Advantage**, **Inventory Scarcity** and
**Opponent Access Rate** separately and feeds them to the simulator — they are never fused into a
hidden score.

### 12. Why being contrarian does not automatically help

A low-ownership team is not automatically valuable. Strategic value requires the popular
alternatives to actually lose, and requires your team to actually win. There is **no contrarian
bonus and no game-theory multiplier anywhere in this code** — the tournament resolves the tradeoff.

Two tests pin this down. With nine rivals certain to take Team A (80%) and Team B at 79%, the
simulator prefers B. Change B to 55% against the same field and it prefers A. Same concentration,
opposite recommendation, no rule changed.

### 13. How the model improves with more pool history

Every pre-lock run can freeze a `RecommendationSnapshot`: inventories, odds timestamps, injuries,
per-entry pick distributions, projected ownership, and every candidate's Pool Win Probability and
Expected Prize Equity. Once the week's real picks are imported, the **Retrospective** page grades
the forecast — predicted vs actual ownership, and the per-entry log loss the model assigned to what
actually happened. Snapshots are never overwritten.

### 14. Why there is no generic "game theory score"

Because it would hide the tradeoff. Ranking is always by a simulated quantity — Pool Win Probability
or Expected Prize Equity — and every other number (projected ownership, expected overlap, fade
leverage, inventory edge) is presented as itself, for explanation only.

### 15. Limitations

- **Predicting human entry behaviour is the weakest link.** The football probabilities have a
  measurable hold-out Brier score; opponent behaviour does not. Football confidence and
  opponent-model confidence are therefore reported **separately**, and pool-equity confidence is
  capped by the weaker of the two.
- **Sensitivity analysis is not optional reading.** Every recommendation is re-simulated under a
  more analytical field, a safety-first field and a higher-randomness field. A pick that only wins
  under one assumption is flagged LOW robustness.
- **Monte Carlo noise is real.** When the gap between two candidates is inside the reported standard
  error, the explanation says so and tells you to raise the simulation budget.
- **The user's simulated future decisions use an approximate rollout**, not a full assignment
  re-solve every simulated week — that would be orders of magnitude too slow. The same policy is
  applied to every candidate, so comparisons stay fair, and each run lists its approximations.
- **Public ownership is a prior, never a substitute.** If 40% of the country is on Buffalo but 70%
  of your rivals have already used it, Buffalo cannot be 40% owned in *your* pool. Private
  constraints always win. The app will not scrape ownership data; supply it manually or leave it out.

---

## Using the pool-equity optimizer

### Importing pool-entry history

Go to **Pool State** and paste or upload a CSV. Long format:

```csv
entry,week,team
Me,1,PHI
Entry A,1,BAL
Entry B,1,CIN
Me,2,DAL
Entry A,2,KC
```

Wide format works too:

```csv
entry,week1,week2,week3,week4
Me,PHI,DAL,BUF,
Entry A,BAL,KC,,
```

With an optional owner column, entries stay independent while keeping the owner's identity:

```csv
entry,owner,week,team
Alice Entry 1,Alice,1,BAL
Alice Entry 2,Alice,1,BUF
Bob Entry 1,Bob,1,CIN
```

Team names are normalised automatically (`KC`, `Kansas City Chiefs`, `OAK`, `WSH` all resolve). Set
**"Which CSV entry is yours?"** to the name of your own row (e.g. `Me`) so it merges into your
existing entry instead of creating a rival.

You always get a **preview before anything is written**, and nothing is silently discarded. Blocking
errors: unknown teams, impossible weeks, a team reused by the same entry, conflicting selections for
one entry-week, a bye-week pick, a missing entry name. Warnings that do not block: exact duplicate
rows, and picks recorded after an entry was eliminated.

Or via the API:

```bash
curl -X POST http://localhost:3000/api/entries/import \
  -H 'content-type: application/json' \
  -d '{"csv":"entry,week,team\nEntry A,1,BAL","commit":false}'   # preview
```

### Updating actual entry picks each week

1. Before the deadline, run the tournament with **Snapshot** enabled (or
   `POST /api/pool-equity/snapshot`). This freezes the pre-lock prediction.
2. Confirm your own pick on the dashboard as usual.
3. Once rivals' picks are visible, record them — either by re-importing that week's CSV, or by
   setting a **known pick** on an entry in the inspector. A known pick replaces that entry's
   predicted distribution with certainty and immediately updates projected ownership and every
   candidate's equity.
4. Advance the week. Inventories, elimination status, the behaviour model and every tournament
   number update automatically.
5. Check **Retrospective** to see how the forecast actually did.

### Interpreting the two recommendations

| | Survival pick | Pool-equity pick |
| --- | --- | --- |
| Question | How likely am I to stay alive? | How likely am I to win this pool? |
| Ignores other entries | Yes, by design | No — models every active entry |
| Ranked by | Optimised path survival probability | Expected Prize Equity (or your chosen objective) |
| Source | Exact no-repeat assignment solver | Multi-entry Monte Carlo tournament |

When they agree, that is a genuinely strong signal. When they differ, the app shows the immediate
survival cost in percentage points beside the pool-equity gain, and explains which is which. The
increased short-term risk of a game-theory pick is never hidden.

### Commands

```bash
npm test                                    # includes 76 game-theory tests
npm run pool-equity-backtest                # historical multi-entry pool simulation
python3 scripts/pool_equity_backtest.py --seasons 2022-2025 --pool-sizes 5,20,100
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

### `You are using Node.js 18.x. For Next.js, Node.js version ">=20.9.0" is required.`

Upgrade Node, then reinstall — Node 18 also caused npm to skip Tailwind's native binary, and that
does not repair itself when you upgrade:

```bash
nvm install 22 && nvm use 22        # or: brew install node@22
rm -rf node_modules package-lock.json .next
npm install
npm run dev
```

If your shell shows `(base)`, conda may be supplying Node. Check with `which node`; either
`conda deactivate` first or `conda install -c conda-forge 'nodejs>=22'`.

### `Cannot find native binding` when the page loads

```
Error: Cannot find native binding. npm has a bug related to optional dependencies
(https://github.com/npm/cli/issues/4828)
./src/app/globals.css ... postcss-loader ...
```

**Check your Node version first — this is usually not the npm bug the message blames.**

```bash
node -v      # must be >= 20.9
```

Tailwind v4 compiles CSS through a platform-specific Rust binary (`@tailwindcss/oxide`, plus
`lightningcss`), shipped as one optional dependency per platform. `@tailwindcss/oxide` declares
`engines: { node: ">= 20" }`, so on Node 18 npm treats the binary as an unmet optional dependency
and skips it without failing the install. The error then appears much later, at first page load,
pointing at an unrelated npm bug.

```bash
nvm install 22 && nvm use 22        # or: brew install node@22
rm -rf node_modules package-lock.json .next
npm install
```

The reinstall is required: upgrading Node alone does not fetch the binary npm already skipped.

If `node -v` was already 20.9+, then it genuinely is [npm/cli#4828](https://github.com/npm/cli/issues/4828)
— the same `rm -rf` and reinstall fixes it. `package-lock.json` is not the problem; it carries every
platform variant, macOS arm64/x64 included, each with a resolved URL and integrity hash.

Deleting `.next` matters either way: the failed CSS build is cached there and will be replayed.

### Buttons do nothing / `npm audit fix --force` upgraded Next to 16

`npm audit fix --force` upgrades across major versions and will move this project to Next 16,
which `package.json` does not pin. On Next 16 the production build is fine, but **`next dev` can
fail to hydrate**: the page renders, yet nothing is clickable — Confirm does not respond, settings
toggles do not save. Two end-to-end tests catch exactly this.

Check what you actually have, and reinstall from the lockfile if it drifted:

```bash
node -e "console.log(require('next/package.json').version)"   # expect 15.5.x

git checkout package.json package-lock.json
rm -rf node_modules .next
npm install
```

Never run `npm audit fix --force` here. The advisories it reports are in dev-only tooling, and it
trades them for an untested major upgrade. Plain `npm audit fix` (no `--force`) is safe.

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
