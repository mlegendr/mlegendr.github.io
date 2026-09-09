/**
 * Recommendation snapshots.
 *
 * Odds and injuries move constantly, so a recommendation is only reproducible
 * if everything behind it is frozen at decision time (§38). The pre-lock
 * snapshot doubles as the record the predicted-vs-actual ownership report
 * grades once the week's real picks are known (§37) — so it is written once and
 * never overwritten.
 */

import "../server-guard";
import { prisma } from "../db";
import { now } from "../clock";
import type { EntryPickDistribution, ProjectedOwnershipRow } from "./types";
import type { PoolEquityResult } from "./service";

export const MODEL_VERSION = "gt-1.0.0";

export interface SnapshotPayload {
  timestamp: string;
  season: number;
  week: number;
  modelVersion: string;
  simulationSeed: number;
  simulationCount: number;
  userUsedTeams: string[];
  activeOpposingEntries: {
    id: string;
    name: string;
    owner: string | null;
    usedTeams: string[];
    remainingTeams: string[];
    knownCurrentPick: string | null;
  }[];
  winProbabilities: { team: string; opponent: string; prob: number; marketProb: number | null }[];
  oddsTimestamps: Record<string, string | null>;
  injuries: { team: string; player: string; position: string; status: string; impact: string }[];
  opponentDistributions: EntryPickDistribution[];
  projectedOwnership: ProjectedOwnershipRow[];
  behaviorModel: { observations: number; confidence: string; isColdStart: boolean; note: string };
  naiveRecommendation: { team: string | null; winProbability: number | null };
  gameTheoryRecommendation: { team: string | null; objective: string };
  poolWinProbabilityByCandidate: Record<string, number>;
  expectedPrizeEquityByCandidate: Record<string, number>;
  sensitivity: unknown;
}

export function buildSnapshotPayload(result: PoolEquityResult): SnapshotPayload {
  const { analysis, survivalSnapshot, states, settings, objective } = result;
  const week = analysis.week;
  const currentProbs = survivalSnapshot.probabilities.filter((p) => p.week === week);

  return {
    timestamp: now().toISOString(),
    season: analysis.season,
    week,
    modelVersion: MODEL_VERSION,
    simulationSeed: analysis.tournament.seed,
    simulationCount: analysis.tournament.simulations,
    userUsedTeams: survivalSnapshot.usedTeams,
    activeOpposingEntries: states
      .filter((s) => !s.entry.isUser && s.entry.status === "ACTIVE")
      .map((s) => ({
        id: s.entry.id,
        name: s.entry.displayName,
        owner: s.entry.ownerName,
        usedTeams: s.usedTeams,
        remainingTeams: s.remainingTeams,
        knownCurrentPick: s.knownCurrentPick,
      })),
    winProbabilities: currentProbs.map((p) => ({
      team: p.team,
      opponent: p.opponent,
      prob: p.finalProb,
      marketProb: p.marketProb,
    })),
    oddsTimestamps: Object.fromEntries(currentProbs.map((p) => [p.gameId, p.oddsLastUpdated])),
    injuries: Object.entries(survivalSnapshot.injuriesByTeam).flatMap(([team, list]) =>
      list.map((i) => ({
        team,
        player: i.playerName,
        position: i.position,
        status: i.status,
        impact: i.impact,
      })),
    ),
    opponentDistributions: analysis.currentDistributions,
    projectedOwnership: analysis.projectedOwnership,
    behaviorModel: {
      observations: analysis.behaviorModel.observations,
      confidence: analysis.behaviorModel.confidence,
      isColdStart: analysis.behaviorModel.isColdStart,
      note: analysis.behaviorModel.fitNote,
    },
    naiveRecommendation: {
      team: survivalSnapshot.candidates[0]?.team ?? null,
      winProbability: survivalSnapshot.candidates[0]?.currentWinProb ?? null,
    },
    gameTheoryRecommendation: { team: analysis.tournament.bestTeam, objective },
    poolWinProbabilityByCandidate: Object.fromEntries(
      analysis.tournament.candidates.map((c) => [c.team, c.poolWinProbability]),
    ),
    expectedPrizeEquityByCandidate: Object.fromEntries(
      analysis.tournament.candidates.map((c) => [c.team, c.expectedPrizeEquity]),
    ),
    sensitivity: analysis.sensitivity,
    ...(settings ? {} : {}),
  };
}

/** Write the pre-lock snapshot for a week. Never overwrites an existing one. */
export async function savePreLockSnapshot(
  poolId: string,
  result: PoolEquityResult,
  force = false,
): Promise<{ created: boolean; id: string }> {
  const payload = buildSnapshotPayload(result);
  const existing = await prisma.recommendationSnapshot.findFirst({
    where: { poolId, season: payload.season, week: payload.week, kind: "PRE_LOCK" },
  });
  if (existing && !force) return { created: false, id: existing.id };

  const row = await prisma.recommendationSnapshot.create({
    data: {
      poolId,
      season: payload.season,
      week: payload.week,
      kind: "PRE_LOCK",
      modelVersion: payload.modelVersion,
      simulationSeed: payload.simulationSeed,
      simulationCount: payload.simulationCount,
      payloadJson: JSON.stringify(payload),
    },
  });
  return { created: true, id: row.id };
}

export async function listSnapshots(poolId: string, season: number) {
  const rows = await prisma.recommendationSnapshot.findMany({
    where: { poolId, season },
    orderBy: [{ week: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    week: r.week,
    kind: r.kind,
    modelVersion: r.modelVersion,
    createdAt: r.createdAt.toISOString(),
    payload: JSON.parse(r.payloadJson) as SnapshotPayload,
  }));
}

/* -------------------------------------------------- predicted vs actual */

export interface OwnershipComparisonRow {
  team: string;
  predictedShare: number;
  predictedEntries: number;
  actualShare: number;
  actualEntries: number;
  errorPoints: number;
}

export interface RetrospectiveWeek {
  week: number;
  userPick: string | null;
  naivePick: string | null;
  poolEquityPick: string | null;
  predictedPoolWinProbability: number | null;
  predictedPrizeEquity: number | null;
  comparison: OwnershipComparisonRow[];
  /** Mean negative log-likelihood the model assigned to what actually happened. */
  opponentLogLoss: number | null;
  observedPicks: number;
  note: string;
}

/**
 * Grade each pre-lock snapshot against what the entries actually picked.
 * Log loss uses the per-entry distribution the model produced for that entry,
 * which is a far sharper test than aggregate ownership error.
 */
export async function buildRetrospective(
  poolId: string,
  season: number,
): Promise<RetrospectiveWeek[]> {
  const snapshots = await listSnapshots(poolId, season);
  if (snapshots.length === 0) return [];

  const entries = await prisma.poolEntry.findMany({ where: { poolId, season } });
  const picks = await prisma.entryPick.findMany({
    where: { season, poolEntryId: { in: entries.map((e) => e.id) } },
  });
  const userEntry = entries.find((e) => e.isUser);

  return snapshots
    .filter((s) => s.kind === "PRE_LOCK")
    .map((snap) => {
      const p = snap.payload;
      const weekPicks = picks.filter((x) => x.week === snap.week);
      const opposing = weekPicks.filter((x) => x.poolEntryId !== userEntry?.id);
      const predictedIds = new Set(p.activeOpposingEntries.map((e) => e.id));
      const relevant = opposing.filter((x) => predictedIds.has(x.poolEntryId));

      const actualCounts = new Map<string, number>();
      for (const x of relevant) actualCounts.set(x.teamAbbr, (actualCounts.get(x.teamAbbr) ?? 0) + 1);
      const denominator = relevant.length || 1;

      const teams = new Set<string>([
        ...p.projectedOwnership.map((o) => o.team),
        ...actualCounts.keys(),
      ]);
      const comparison: OwnershipComparisonRow[] = [...teams]
        .map((team) => {
          const predicted = p.projectedOwnership.find((o) => o.team === team);
          const actualEntries = actualCounts.get(team) ?? 0;
          const predictedShare = predicted?.share ?? 0;
          const actualShare = actualEntries / denominator;
          return {
            team,
            predictedShare,
            predictedEntries: predicted?.expectedEntries ?? 0,
            actualShare,
            actualEntries,
            errorPoints: (actualShare - predictedShare) * 100,
          };
        })
        .filter((r) => r.predictedEntries > 0.01 || r.actualEntries > 0)
        .sort((a, b) => b.actualShare - a.actualShare || b.predictedShare - a.predictedShare);

      let logLossSum = 0;
      let scored = 0;
      for (const actual of relevant) {
        const dist = p.opponentDistributions.find((d) => d.entryId === actual.poolEntryId);
        if (!dist) continue;
        const prob = dist.distribution[actual.teamAbbr] ?? 1e-6;
        logLossSum += -Math.log(Math.max(prob, 1e-9));
        scored += 1;
      }

      const userPickRow = weekPicks.find((x) => x.poolEntryId === userEntry?.id);
      return {
        week: snap.week,
        userPick: userPickRow?.teamAbbr ?? null,
        naivePick: p.naiveRecommendation.team,
        poolEquityPick: p.gameTheoryRecommendation.team,
        predictedPoolWinProbability: p.gameTheoryRecommendation.team
          ? (p.poolWinProbabilityByCandidate[p.gameTheoryRecommendation.team] ?? null)
          : null,
        predictedPrizeEquity: p.gameTheoryRecommendation.team
          ? (p.expectedPrizeEquityByCandidate[p.gameTheoryRecommendation.team] ?? null)
          : null,
        comparison,
        opponentLogLoss: scored > 0 ? logLossSum / scored : null,
        observedPicks: relevant.length,
        note:
          relevant.length === 0
            ? "No opposing-entry picks recorded for this week yet — import them to grade the forecast."
            : `Graded against ${relevant.length} recorded opposing-entry selection(s).`,
      };
    });
}
