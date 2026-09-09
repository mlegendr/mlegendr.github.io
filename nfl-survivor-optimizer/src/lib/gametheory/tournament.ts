/**
 * Multi-entry Monte Carlo tournament simulator.
 *
 * For each team the user could legally pick this week, we replay the rest of
 * the pool many times and count how often the user ends up a winner. That is
 * where Pool Win Probability and Expected Prize Equity come from — they are
 * simulation frequencies, never a weighted heuristic.
 *
 * THE CORRECTNESS REQUIREMENT (§14). Each NFL game is sampled **once per
 * simulated week** and every entry that picked a team in that game reads the
 * same outcome. So two entries on Dallas always share a fate; an entry on
 * Dallas and one on Dallas's opponent can never both survive; three entries on
 * Buffalo all die together when Buffalo loses. Simulating survival per entry
 * independently would destroy exactly the correlation that makes pool strategy
 * interesting.
 *
 * COMMON RANDOM NUMBERS. Game outcomes are drawn from a hash of
 * (seed, simIndex, week, gameIndex) rather than a sequential stream, so the
 * same simulation index produces the same football results for every candidate.
 * Candidates are therefore compared on identical worlds, which removes most of
 * the Monte Carlo noise from the *difference* between them.
 *
 * APPROXIMATIONS, stated plainly (§17):
 *   - The user's simulated future decisions use a receding-horizon rollout
 *     policy (win probability, precomputed future-value cost, and a
 *     differentiation term), not a full re-solve of the assignment problem each
 *     simulated week. A full re-solve inside every sim-week would be several
 *     orders of magnitude too slow. The SAME policy is applied for every
 *     candidate, so candidate comparisons stay fair.
 *   - Opponent future-week utilities are precomputed per entry per week and
 *     re-filtered by that entry's live inventory each simulated week, so
 *     inventory evolves correctly while utilities do not re-fit mid-simulation.
 *   - Expected-overlap pressure in the rollout uses week-1 projected ownership
 *     as a proxy for later weeks.
 */

import { TEAM_ABBRS } from "../teams";
import { safeLog } from "../probability";
import type { GameProbability } from "../types";
import type {
  CandidateTournamentResult,
  EntryPickDistribution,
  EntryState,
  GameTheorySettings,
  PoolObjective,
  PoolRules,
  TournamentSummary,
} from "./types";
import { objectiveValue, resolveObjective } from "./types";

const TEAM_INDEX = new Map(TEAM_ABBRS.map((t, i) => [t, i]));

/** 32-bit mix; deterministic and fast. */
function hashUniform(a: number, b: number, c: number, d: number): number {
  let h = (a ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ b, 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  h = Math.imul(h ^ c, 0x27d4eb2f) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x165667b1) >>> 0;
  h = Math.imul(h ^ d, 0x9e3779b1) >>> 0;
  h ^= h >>> 15;
  return (h >>> 0) / 4294967296;
}

interface WeekGame {
  gameId: string;
  homeTeam: number;
  awayTeam: number;
  homeWinProbability: number;
}

interface WeekPlan {
  week: number;
  games: WeekGame[];
  /** teamIndex -> index into `games`, or -1 when the team has no game (bye). */
  gameOfTeam: Int32Array;
  /** teamIndex -> 1 when legally selectable this week. */
  selectable: Uint8Array;
  /** teamIndex -> user rollout score (higher is better). */
  userScore: Float64Array;
}

/** One simulated week, recorded for tests and debugging. */
export interface TraceRecord {
  candidate: string;
  sim: number;
  week: number;
  /** entryId -> team picked that week. */
  picks: Record<string, string>;
  /** entryId -> whether the entry survived that week. */
  survived: Record<string, boolean>;
}

export interface TournamentTrace {
  /** Only the first `maxSims` simulations of each candidate are recorded. */
  maxSims: number;
  records: TraceRecord[];
}

export interface TournamentInput {
  currentWeek: number;
  weeks: number[];
  probabilities: GameProbability[];
  states: EntryState[];
  /** Predicted (or known) distributions for the CURRENT week. */
  currentDistributions: EntryPickDistribution[];
  /** entryId -> week -> team -> probability, for simulated future weeks. */
  futureDistributions: Map<string, Map<number, Record<string, number>>>;
  settings: GameTheorySettings;
  /** Teams the user may legally pick this week. */
  candidates: string[];
  /** team -> season log-prob the user gives up by spending it. */
  futureValueCost: Map<string, number>;
  /** team -> projected current-week ownership share, used by the rollout. */
  projectedOwnership: Map<string, number>;
  isPickable: (team: string, week: number, p: GameProbability) => boolean;
  simulations: number;
  seed: number;
  /** Optional recorder; used by the game-outcome correlation tests. */
  trace?: TournamentTrace;
}

interface SimEntry {
  index: number;
  id: string;
  isUser: boolean;
  usedMask: number;
  alive: boolean;
  eliminatedWeek: number;
  /** week -> Float64Array of cumulative weights over team indices. */
  weights: Map<number, Float64Array>;
  knownCurrent: number; // team index, or -1
}

/** Build per-week game tables and the user's rollout scores. */
function buildWeekPlans(input: TournamentInput): WeekPlan[] {
  const byWeek = new Map<number, GameProbability[]>();
  for (const p of input.probabilities) {
    const list = byWeek.get(p.week) ?? [];
    list.push(p);
    byWeek.set(p.week, list);
  }

  const γ = input.settings.rolloutFutureValueWeight;
  const δ = input.settings.rolloutDifferentiationWeight;

  return input.weeks.map((week) => {
    const rows = byWeek.get(week) ?? [];
    const games: WeekGame[] = [];
    const seen = new Set<string>();
    const gameOfTeam = new Int32Array(32).fill(-1);
    const selectable = new Uint8Array(32);
    const userScore = new Float64Array(32).fill(-Infinity);

    for (const p of rows) {
      if (!seen.has(p.gameId)) {
        seen.add(p.gameId);
        const home = p.isHome ? p.team : p.opponent;
        const away = p.isHome ? p.opponent : p.team;
        const homeProb = p.isHome ? p.finalProb : 1 - p.finalProb;
        games.push({
          gameId: p.gameId,
          homeTeam: TEAM_INDEX.get(home) ?? -1,
          awayTeam: TEAM_INDEX.get(away) ?? -1,
          homeWinProbability: homeProb,
        });
      }
      const ti = TEAM_INDEX.get(p.team);
      if (ti == null) continue;
      gameOfTeam[ti] = games.findIndex((g) => g.gameId === p.gameId);
      if (input.isPickable(p.team, week, p)) {
        selectable[ti] = 1;
        const fv = input.futureValueCost.get(p.team) ?? 0;
        const own = input.projectedOwnership.get(p.team) ?? 0;
        userScore[ti] = safeLog(p.finalProb) - γ * fv - δ * own;
      }
    }
    return { week, games, gameOfTeam, selectable, userScore };
  });
}

/** Cumulative sampling weights over team indices for one entry-week. */
function toWeights(distribution: Record<string, number>): Float64Array {
  const w = new Float64Array(32);
  for (const [team, p] of Object.entries(distribution)) {
    const i = TEAM_INDEX.get(team);
    if (i != null) w[i] = p;
  }
  return w;
}

/** Sample a team index, renormalising over teams the entry can still use. */
function sampleTeam(weights: Float64Array, usedMask: number, selectable: Uint8Array, u: number): number {
  let total = 0;
  for (let i = 0; i < 32; i++) {
    if (weights[i] > 0 && !(usedMask & (1 << i)) && selectable[i]) total += weights[i];
  }
  if (total <= 0) {
    // No modelled option survives this entry's inventory; fall back to any
    // legal team so the entry still makes a pick rather than vanishing.
    const legal: number[] = [];
    for (let i = 0; i < 32; i++) if (!(usedMask & (1 << i)) && selectable[i]) legal.push(i);
    if (legal.length === 0) return -1;
    return legal[Math.min(legal.length - 1, Math.floor(u * legal.length))];
  }
  let acc = 0;
  const target = u * total;
  let last = -1;
  for (let i = 0; i < 32; i++) {
    if (weights[i] > 0 && !(usedMask & (1 << i)) && selectable[i]) {
      acc += weights[i];
      last = i;
      if (target < acc) return i;
    }
  }
  return last;
}

/** Greedy receding-horizon rollout for the user's simulated future weeks. */
function userRolloutPick(plan: WeekPlan, usedMask: number): number {
  let best = -1;
  let bestScore = -Infinity;
  for (let i = 0; i < 32; i++) {
    if (usedMask & (1 << i)) continue;
    if (!plan.selectable[i]) continue;
    const s = plan.userScore[i];
    if (s > bestScore) {
      bestScore = s;
      best = i;
    }
  }
  return best;
}

const RESULT_WIN = 0;
const RESULT_LOSS = 1;
const RESULT_TIE = 2;

/** Resolve one sampled game into a per-team result. */
function teamResult(
  game: WeekGame,
  teamIndex: number,
  u: number,
  rules: PoolRules,
): number {
  if (u < rules.tieProbability) return RESULT_TIE;
  const rescaled = (u - rules.tieProbability) / (1 - rules.tieProbability);
  const homeWins = rescaled < game.homeWinProbability;
  const isHome = teamIndex === game.homeTeam;
  if (homeWins) return isHome ? RESULT_WIN : RESULT_LOSS;
  return isHome ? RESULT_LOSS : RESULT_WIN;
}

export interface CandidateAccumulator {
  team: string;
  survivedWeek: number;
  anyWin: number;
  soleWin: number;
  sharedWin: number;
  equitySum: number;
  equitySumSq: number;
  finishSum: number;
  opponentsRemainingSum: number;
  opponentsRemainingCount: number;
  eliminationWeeks: number[];
  milestoneWeek: Map<number, number>;
  finalFive: number;
  finalTwo: number;
  fieldEliminatedGivenSurvival: number;
  fieldEliminatedCount: number;
  fadeLeverageEquity: number;
}

/**
 * Run the tournament for every candidate.
 *
 * The user's elimination ends a simulation early: once the user is out, their
 * prize equity is zero no matter what happens next — unless every remaining
 * entry was eliminated in the same week, which is the one case the all-lose
 * rule can still pay out, and which is handled explicitly.
 */
export function runTournament(input: TournamentInput): TournamentSummary {
  const started = Date.now();
  const rules = input.settings.rules;
  const objective = resolveObjective(input.settings);
  const plans = buildWeekPlans(input);
  const planByWeek = new Map(plans.map((p) => [p.week, p]));
  const weeks = input.weeks;

  const activeStates = input.states.filter(
    (s) => s.entry.status === "ACTIVE" || s.entry.status === "WINNER",
  );
  const opponents = activeStates.filter((s) => !s.entry.isUser);
  const entryCount = activeStates.length;

  // ---- Static per-entry sampling weights, built once. ---------------------
  const template: SimEntry[] = activeStates.map((s, index) => {
    let mask = 0;
    for (const t of s.usedTeams) {
      const i = TEAM_INDEX.get(t);
      if (i != null) mask |= 1 << i;
    }
    const weights = new Map<number, Float64Array>();
    const current = input.currentDistributions.find((d) => d.entryId === s.entry.id);
    if (current) weights.set(input.currentWeek, toWeights(current.distribution));
    const future = input.futureDistributions.get(s.entry.id);
    if (future) {
      for (const [w, dist] of future) weights.set(w, toWeights(dist));
    }
    const known = s.knownCurrentPick ? (TEAM_INDEX.get(s.knownCurrentPick) ?? -1) : -1;
    return {
      index,
      id: s.entry.id,
      isUser: s.entry.isUser,
      usedMask: mask,
      alive: true,
      eliminatedWeek: -1,
      weights,
      knownCurrent: known,
    };
  });

  const userIndex = template.findIndex((e) => e.isUser);
  const opponentCount = opponents.length;

  // The most-owned alternative, for the fade-leverage explanation metric.
  let topOwnedTeam = -1;
  let topOwnedShare = 0;
  for (const [team, share] of input.projectedOwnership) {
    if (share > topOwnedShare) {
      topOwnedShare = share;
      topOwnedTeam = TEAM_INDEX.get(team) ?? -1;
    }
  }

  const milestoneWeeks = weeks.filter((w) => w > input.currentWeek).slice(0, 20);
  const results: CandidateTournamentResult[] = [];

  const smallField = entryCount > 0 && entryCount <= input.settings.smallFieldThreshold;
  const sims = Math.max(
    50,
    Math.round(input.simulations * (smallField ? input.settings.smallFieldSimulationMultiplier : 1)),
  );

  for (const candidate of input.candidates) {
    const candidateIndex = TEAM_INDEX.get(candidate);
    if (candidateIndex == null || userIndex < 0) continue;

    const acc: CandidateAccumulator = {
      team: candidate,
      survivedWeek: 0,
      anyWin: 0,
      soleWin: 0,
      sharedWin: 0,
      equitySum: 0,
      equitySumSq: 0,
      finishSum: 0,
      opponentsRemainingSum: 0,
      opponentsRemainingCount: 0,
      eliminationWeeks: [],
      milestoneWeek: new Map(milestoneWeeks.map((w) => [w, 0])),
      finalFive: 0,
      finalTwo: 0,
      fieldEliminatedGivenSurvival: 0,
      fieldEliminatedCount: 0,
      fadeLeverageEquity: 0,
    };

    // Reusable per-sim arrays; allocating inside the loop dominates otherwise.
    const usedMask = new Int32Array(entryCount);
    const alive = new Uint8Array(entryCount);
    const elimWeek = new Int32Array(entryCount);
    const picks = new Int32Array(entryCount);
    const gameOutcome = new Int8Array(64);
    const gameSampled = new Uint8Array(64);

    for (let sim = 0; sim < sims; sim++) {
      for (let e = 0; e < entryCount; e++) {
        usedMask[e] = template[e].usedMask;
        alive[e] = 1;
        elimWeek[e] = -1;
      }
      let aliveCount = entryCount;
      let userAlive = true;
      let winners: number[] | null = null;
      let topOwnedLostThisWeek = false;
      let userSurvivedCurrentWeek = false;

      for (let wi = 0; wi < weeks.length; wi++) {
        const week = weeks[wi];
        const plan = planByWeek.get(week);
        if (!plan) continue;

        // ---- 1. every alive entry chooses a team --------------------------
        gameSampled.fill(0);
        for (let e = 0; e < entryCount; e++) {
          picks[e] = -1;
          if (!alive[e]) continue;
          const t = template[e];
          if (t.isUser) {
            picks[e] = week === input.currentWeek ? candidateIndex : userRolloutPick(plan, usedMask[e]);
          } else if (week === input.currentWeek && t.knownCurrent >= 0) {
            picks[e] = t.knownCurrent; // §28: a known pick is not predicted
          } else {
            const w = t.weights.get(week);
            const u = hashUniform(input.seed, sim, week * 131 + 7, e * 977 + 13);
            picks[e] = w ? sampleTeam(w, usedMask[e], plan.selectable, u) : userRolloutPick(plan, usedMask[e]);
          }
        }

        // ---- 2. sample each involved NFL game EXACTLY ONCE ---------------
        // This is what makes entries on the same team share a fate.
        for (let e = 0; e < entryCount; e++) {
          if (!alive[e] || picks[e] < 0) continue;
          const gi = plan.gameOfTeam[picks[e]];
          if (gi < 0 || gameSampled[gi]) continue;
          gameSampled[gi] = 1;
          gameOutcome[gi] = -1;
        }
        const gameUniform = new Float64Array(plan.games.length);
        for (let gi = 0; gi < plan.games.length; gi++) {
          if (gameSampled[gi]) {
            gameUniform[gi] = hashUniform(input.seed, sim, week * 977 + 3, gi * 31 + 5);
          }
        }

        // ---- 3. resolve every entry against the shared outcomes ----------
        let eliminatedThisWeek = 0;
        topOwnedLostThisWeek = false;
        for (let e = 0; e < entryCount; e++) {
          if (!alive[e]) continue;
          const team = picks[e];
          if (team < 0) {
            // No legal pick left: the entry cannot continue.
            alive[e] = 0;
            elimWeek[e] = week;
            eliminatedThisWeek += 1;
            continue;
          }
          const gi = plan.gameOfTeam[team];
          const result =
            gi < 0 ? RESULT_LOSS : teamResult(plan.games[gi], team, gameUniform[gi], rules);
          const eliminated =
            result === RESULT_LOSS || (result === RESULT_TIE && rules.tieCountsAsLoss);
          if (eliminated) {
            alive[e] = 0;
            elimWeek[e] = week;
            eliminatedThisWeek += 1;
          } else {
            usedMask[e] |= 1 << team;
          }
        }

        if (topOwnedTeam >= 0) {
          const gi = plan.gameOfTeam[topOwnedTeam];
          if (gi >= 0 && gameSampled[gi]) {
            topOwnedLostThisWeek =
              teamResult(plan.games[gi], topOwnedTeam, gameUniform[gi], rules) !== RESULT_WIN;
          }
        }

        if (input.trace && sim < input.trace.maxSims) {
          const picked: Record<string, string> = {};
          const survived: Record<string, boolean> = {};
          for (let e = 0; e < entryCount; e++) {
            if (picks[e] < 0) continue;
            picked[template[e].id] = TEAM_ABBRS[picks[e]];
            survived[template[e].id] = alive[e] === 1;
          }
          input.trace.records.push({ candidate, sim, week, picks: picked, survived });
        }

        const previouslyAlive = aliveCount;
        aliveCount = previouslyAlive - eliminatedThisWeek;
        userAlive = alive[userIndex] === 1;

        if (week === input.currentWeek) {
          userSurvivedCurrentWeek = userAlive;
          if (userAlive) {
            acc.survivedWeek += 1;
            acc.opponentsRemainingSum += aliveCount - 1;
            acc.opponentsRemainingCount += 1;
            if (opponentCount > 0) {
              acc.fieldEliminatedGivenSurvival +=
                (opponentCount - (aliveCount - 1)) / opponentCount;
              acc.fieldEliminatedCount += 1;
            }
          }
        }

        // ---- 4. stopping conditions --------------------------------------
        if (aliveCount === 0) {
          // Everyone still standing lost in the same week.
          if (rules.allLoseRule === "REINSTATE_ALL") {
            for (let e = 0; e < entryCount; e++) {
              if (elimWeek[e] === week) {
                alive[e] = 1;
                elimWeek[e] = -1;
              }
            }
            aliveCount = previouslyAlive;
            userAlive = alive[userIndex] === 1;
          } else if (rules.allLoseRule === "SHARE_AMONG_LAST") {
            winners = [];
            for (let e = 0; e < entryCount; e++) if (elimWeek[e] === week) winners.push(e);
            break;
          } else {
            winners = [];
            break;
          }
        }

        if (userAlive) {
          if (aliveCount <= 5) acc.finalFive += 1;
          if (aliveCount <= 2) acc.finalTwo += 1;
          const m = acc.milestoneWeek.get(week);
          if (m != null) acc.milestoneWeek.set(week, m + 1);
        }

        if (aliveCount === 1 && rules.continueUntilOneRemains) {
          winners = [];
          for (let e = 0; e < entryCount; e++) if (alive[e]) winners.push(e);
          break;
        }

        if (!userAlive) break; // user's equity is settled at zero from here
      }

      if (winners === null) {
        winners = [];
        for (let e = 0; e < entryCount; e++) if (alive[e]) winners.push(e);
      }

      const userWon = winners.includes(userIndex);
      const equity =
        userWon && winners.length > 0
          ? rules.splitPrizeEqually
            ? 1 / winners.length
            : 1
          : 0;

      acc.equitySum += equity;
      acc.equitySumSq += equity * equity;
      if (userWon) {
        acc.anyWin += 1;
        if (winners.length === 1) acc.soleWin += 1;
        else acc.sharedWin += 1;
        if (topOwnedLostThisWeek && userSurvivedCurrentWeek) acc.fadeLeverageEquity += equity;
      }

      // Finishing position: 1 for a winner, otherwise 1 + entries that outlasted.
      const userElim = elimWeek[userIndex];
      let outlasted = 0;
      for (let e = 0; e < entryCount; e++) {
        if (e === userIndex) continue;
        const other = elimWeek[e];
        if (userElim < 0) continue;
        if (other < 0 || other > userElim) outlasted += 1;
      }
      acc.finishSum += userWon ? 1 : 1 + outlasted;
      if (userElim > 0) acc.eliminationWeeks.push(userElim);
    }

    const n = sims;
    const meanEquity = acc.equitySum / n;
    const variance = Math.max(0, acc.equitySumSq / n - meanEquity * meanEquity);
    acc.eliminationWeeks.sort((a, b) => a - b);
    const median =
      acc.eliminationWeeks.length === 0
        ? null
        : acc.eliminationWeeks[Math.floor(acc.eliminationWeeks.length / 2)];

    const prob = input.probabilities.find(
      (p) => p.week === input.currentWeek && p.team === candidate,
    );
    const ownership = input.projectedOwnership.get(candidate) ?? 0;

    const milestones: Record<string, number> = {};
    for (const [week, count] of acc.milestoneWeek) {
      milestones[`week${week}`] = count / n;
    }
    milestones.finalFive = acc.finalFive / n;
    milestones.finalTwo = acc.finalTwo / n;

    results.push({
      team: candidate,
      gameId: prob?.gameId ?? "",
      opponent: prob?.opponent ?? "",
      isHome: prob?.isHome ?? false,
      currentWinProbability: prob?.finalProb ?? 0,
      survivesCurrentWeek: acc.survivedWeek / n,
      poolWinProbability: acc.anyWin / n,
      soleVictoryProbability: acc.soleWin / n,
      sharedVictoryProbability: acc.sharedWin / n,
      expectedPrizeEquity: meanEquity,
      averageFinishingPosition: acc.finishSum / n,
      expectedOpponentsRemaining:
        acc.opponentsRemainingCount > 0
          ? acc.opponentsRemainingSum / acc.opponentsRemainingCount
          : 0,
      medianEliminationWeek: median,
      milestones,
      expectedPickOverlap: ownership * opponentCount,
      projectedPoolOwnership: ownership,
      expectedFieldEliminationGivenSurvival:
        acc.fieldEliminatedCount > 0
          ? acc.fieldEliminatedGivenSurvival / acc.fieldEliminatedCount
          : 0,
      popularAlternativeFadeLeverage:
        acc.equitySum > 0 ? acc.fadeLeverageEquity / acc.equitySum : 0,
      inventoryEdgeAfterPick: 0, // filled in by the caller, which knows the edges
      simulations: n,
      standardError: Math.sqrt(variance / n),
    });
  }

  const ranked = [...results].sort(
    (a, b) => objectiveValue(b, objective) - objectiveValue(a, objective),
  );
  const survivalBest = [...results].sort(
    (a, b) => b.currentWinProbability - a.currentWinProbability,
  )[0];

  return {
    objective,
    simulations: sims,
    seed: input.seed,
    candidates: ranked,
    bestTeam: ranked[0]?.team ?? null,
    survivalBestTeam: survivalBest?.team ?? null,
    activeOpponents: opponentCount,
    activeEntries: entryCount,
    weeksSimulated: weeks.length,
    elapsedMs: Date.now() - started,
    approximations: [
      "The user's simulated future picks use a receding-horizon rollout (win probability, precomputed future-value cost, differentiation), not a full assignment re-solve each simulated week.",
      "Opponent utilities are precomputed per entry per week and re-filtered by live inventory; they are not re-fitted mid-simulation.",
      "Expected-overlap pressure in the rollout uses current-week projected ownership as a proxy for later weeks.",
      smallField
        ? `Small field (${entryCount} entries): simulation budget multiplied by ${input.settings.smallFieldSimulationMultiplier}.`
        : "Standard simulation budget.",
    ],
  };
}

export function objectiveOf(objective: PoolObjective) {
  return (r: CandidateTournamentResult) => objectiveValue(r, objective);
}
