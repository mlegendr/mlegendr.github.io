# FPL Squad Manager (2026/27)

A weekly decision tool for Fantasy Premier League. It optimises your starting XI,
plans transfers from a shortlist you supply, keeps your budget and free transfers
honest, and picks your armbands.

It runs entirely in the browser. Your squad never leaves your machine — state
lives in `localStorage` and can be exported to JSON.

## The weekly loop

1. **Optimise the XI.** The *Lineup* tab picks the highest-projected legal XI,
   orders the bench, and names a captain and vice-captain. All eight legal
   formations are compared exactly, so the result is optimal for the projections
   given.
2. **Plan transfers.** Add the players you're considering to the shortlist on the
   *Transfers* tab, then hit *Suggest transfer strategy*. Only shortlisted players
   can come in. Every legal combination is scored over the horizon and ranked.
3. **Record what you did.** Apply a suggested plan, or enter your moves by hand.
   Either way the squad, bank, selling prices and free-transfer count update.
4. **Declare chips.** The tool **never suggests a chip**. You tell it which chip
   you're playing and it feeds that into everything else.

## What the transfer planner weighs

- **Budget** — your bank plus what each outgoing player actually *sells* for
  (FPL banks half of any price rise, rounded down).
- **Fixtures** — difficulty over the next 6 gameweeks (configurable), including
  blanks and doubles.
- **Form, minutes and availability** — injuries and doubts scale a projection
  down; a player with no chance of playing projects zero.
- **Free transfers** — a hit is only recommended when the extra points clear the
  4-point cost. A banked transfer is given option value (default 0.8 points), so
  a marginal move is correctly rejected in favour of rolling.
- **Legality** — 2/5/5/3 by position and a maximum of 3 players per club are
  enforced on every candidate plan.

Plans are ranked by net gain against doing nothing. Holding always scores exactly
zero, so any positive number is a real improvement.

## Chips

Declare a chip on the *Squad* tab and the rest of the app adjusts:

| Chip | Effect |
| --- | --- |
| **Wildcard** | Transfers cost nothing and are permanent. Banked free transfers are kept. |
| **Free Hit** | Transfers cost nothing for one gameweek. The planner values only that week, and the squad reverts when you advance. |
| **Triple Captain** | The captain scores treble in the projections. |
| **Bench Boost** | All 15 players count towards the projected total. |

A chip is only *reserved* while it is selected — clear it before the deadline and
you get it back. Advancing the gameweek spends it. The first set expires after
GW19; a fresh set arrives for GW20.

## Your recorded squad

`fpl/data/squad-2026-27.json` holds the opening squad written down by name, club,
position and the price paid:

```
GK   Kinsky 4.5, Dubravka 4.0                              (TOT, TOT)
DEF  Gabriel 8.0, Mosquera 5.5, Maguire 5.0,
     Greaves 4.0, Thomas 4.0                               (ARS, ARS, MUN, IPS, COV)
MID  B.Fernandes 12.0, Mbeumo 8.0, Tzolis 6.5,
     Groß 5.5, Sangaré 5.5                                 (MUN, MUN, ARS, BHA, SUN)
FWD  Haaland 15.5, João Pedro 7.5, Kusi-Asare 4.5          (MCI, CHE, FUL)

£100.0m exactly, £0.0m in the bank. Arsenal and Man Utd both on the 3-player cap.
```

Press **Load recorded squad** on the *Squad* tab and the names are resolved
against whatever snapshot is loaded, then dropped into the builder so you can
check prices and budget before confirming. Matching normalises accents,
punctuation and the German sharp s — `Kinsky` finds `Kinský`, `Groß` finds
`Gross` — and uses the club as a tiebreaker when a surname is shared. A name
that genuinely could mean two players is reported as ambiguous rather than
guessed at.

If the file records a starting XI and armbands (`"start": true`, `"benchOrder"`,
`"captain"`), those are kept too and the *Lineup* tab tells you only what to
**change** rather than restating the whole team. Without them it simply
recommends a fresh XI.

The recorded price does two jobs. It separates two players a name and club
cannot, and it becomes the **purchase price** — which is what governs the
selling price, since FPL only hands back half of any rise. A player whose price
has moved since you bought them is listed as `paid £8.0m, now £8.3m`, and the
budget is judged on what you paid, so a squad that has risen in value is not
retrospectively over budget.

If an entry has no `price`, that player's purchase price falls back to the price
at import.

## Getting real data

The official FPL API does not send CORS headers, so a web page cannot fetch it.
Run the refresh script instead. The start script does both jobs — refresh the
data, then serve the app:

```sh
./tools/start.sh                       # then open http://localhost:8123
```

If the refresh fails it still starts, and the banner on the page tells you which
data you are looking at. `./tools/start.sh 9000` uses a different port and
`--no-refresh` skips the fetch. The two steps by hand are:

```sh
python3 tools/refresh_fpl_data.py      # writes fpl/data/snapshot.json
python3 -m http.server -d fpl 8123
```

On Windows, run those two directly (`py -3` instead of `python3`); the shell
script needs Git Bash or WSL.

The app tries live data first, falls back to `data/snapshot.json`, and finally to
a **demo dataset of invented clubs and players** so the interface always works.
A banner tells you which one you're looking at. You can also load a snapshot file
by hand from the *Manage* tab.

Re-run the refresh before each deadline — prices, form, injuries and `ep_next`
all move during the week.

## How projections are built

Each player's gameweek is priced one 2026/27 scoring rule at a time
(`js/xp.js`), then summed over their fixtures — zero for a blank, both games for
a double:

- **Minutes** drive everything. Season minutes-per-game are blended with a prior,
  weighted by how many games have been played, then scaled by availability.
- **Goals and assists** come from expected-goals and expected-assists per 90,
  scaled by minutes and fixture difficulty, with a small form adjustment.
- **Clean sheets** use a Poisson model on expected goals conceded, and only pay
  out if the player is projected to reach 60 minutes.
- **Goals conceded and saves** use the exact Poisson expectation of the FPL
  step functions (−1 per 2 conceded, +1 per 3 saves) rather than a linear
  approximation.
- **Defensive contribution** prices the 2-point threshold properly: 10 CBIT for
  defenders, 12 CBIRT for midfielders and forwards, and nothing for goalkeepers.
- **Bonus** is estimated from season bonus per 90, damped towards the mean.
- For the immediate gameweek the result is blended with FPL's own `ep_next`
  (35% by default) as a regulariser.

Later gameweeks are discounted (0.92 per week) when ranking transfer plans, since
distant projections are less certain.

### Where the model is weak

- **Early season.** With few games played, projections lean on the minutes prior
  and `ep_next`. Use the *Manage* tab to override expected minutes for players
  you know are nailed or rotation risks.
- **Rotation and cup congestion** are not modelled. A manual availability
  override is the right tool.
- **Bonus and defensive contribution** are rate-based; a player whose role has
  just changed will be mispriced until the data catches up.
- The `defensive_contribution` API field has appeared both as points and as raw
  action counts. The loader detects which and normalises, but a per-player
  defensive-contribution override always wins.

Projections are estimates, not predictions. Treat the rankings as a starting
point for a decision, not the decision.

## Tests

```sh
node --test 'fpl/tests/*.test.mjs'
```

62 tests cover the scoring rules, the selling-price and free-transfer arithmetic,
squad legality, the XI optimiser, chip behaviour, and the transfer planner
(including that it refuses unaffordable moves, respects the club limit, and takes
a hit only when it pays), plus name resolution against accented and shared
surnames.

## Layout

```
fpl/
  index.html        app shell
  app.css           styling, light and dark
  js/rules.js       2026/27 rules and scoring constants
  js/snapshot.js    normalises FPL API data
  js/xp.js          expected-points model
  js/lineup.js      XI, bench order, captain and vice
  js/squad.js       squad state, transfers, budget, chips
  js/transfers.js   transfer planner
  js/roster.js      resolves a squad written by name into player ids
  js/store.js       persistence and data loading
  js/app.js         UI
  data/squad-2026-27.json  your recorded opening squad
  tests/            node --test suites
tools/
  start.sh                refresh data and serve the app
  refresh_fpl_data.py     fetches a live snapshot
  make_demo_snapshot.mjs  regenerates the demo dataset
```
