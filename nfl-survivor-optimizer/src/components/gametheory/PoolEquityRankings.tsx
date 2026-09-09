"use client";

import * as React from "react";
import type { CandidateEvaluation } from "@/lib/types";
import type {
  CandidateTournamentResult,
  PoolObjective,
  ProjectedOwnershipRow,
  RelativeFutureValueLike,
  SensitivityReport,
} from "./rankingTypes";
import { cn, pct } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle, Hint } from "../ui";

type SortKey =
  | "win"
  | "naive"
  | "ownership"
  | "expectedEntries"
  | "overlap"
  | "relativeFV"
  | "poolWin"
  | "equity";

const COLUMNS: { key: SortKey | null; label: string; hint?: string; align: "left" | "right" }[] = [
  { key: null, label: "#", align: "left" },
  { key: null, label: "Team", align: "left" },
  { key: null, label: "Opponent", align: "left" },
  { key: "win", label: "Win %", align: "right", hint: "Blended market + model probability this week." },
  { key: "naive", label: "Naive path %", align: "right", hint: "The survival optimizer's own horizon path probability." },
  { key: "ownership", label: "Proj. ownership", align: "right", hint: "Share of active opposing entries predicted to pick this team." },
  { key: "expectedEntries", label: "Exp. opp. entries", align: "right", hint: "Expected number of opposing entries on this team." },
  { key: "overlap", label: "Exp. overlap", align: "right", hint: "Opposing entries expected to share your fate exactly." },
  { key: "relativeFV", label: "Relative future value", align: "right", hint: "Own future value re-weighted by how few opponents still hold the team." },
  { key: "poolWin", label: "Pool win %", align: "right", hint: "Simulated probability you end up among the winners." },
  { key: "equity", label: "Prize equity %", align: "right", hint: "Simulated expected share of the prize, splitting ties equally." },
];

/**
 * §39 — one row per legal candidate, ranked by the configured objective.
 * There is deliberately no "game theory score" column: the ranking is a
 * simulated quantity, and every explanatory metric is shown as itself.
 */
export function PoolEquityRankings({
  candidates,
  survival,
  ownership,
  relativeFutureValue,
  objective,
  naivePick,
  poolPick,
  sensitivity,
  horizonKey,
}: {
  candidates: CandidateTournamentResult[];
  survival: CandidateEvaluation[];
  ownership: ProjectedOwnershipRow[];
  relativeFutureValue: RelativeFutureValueLike[];
  objective: PoolObjective;
  naivePick: string | null;
  poolPick: string | null;
  sensitivity: SensitivityReport | null;
  horizonKey: string;
}) {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({
    key: objective === "EXPECTED_PRIZE_EQUITY" ? "equity" : "poolWin",
    dir: -1,
  });

  const survivalByTeam = new Map(survival.map((s) => [s.team, s]));
  const ownershipByTeam = new Map(ownership.map((o) => [o.team, o]));
  const rfvByTeam = new Map(relativeFutureValue.map((r) => [r.team, r]));

  const value = (c: CandidateTournamentResult, key: SortKey): number => {
    switch (key) {
      case "win":
        return c.currentWinProbability;
      case "naive":
        return survivalByTeam.get(c.team)?.pathSurvival[horizonKey] ?? 0;
      case "ownership":
        return ownershipByTeam.get(c.team)?.share ?? 0;
      case "expectedEntries":
        return ownershipByTeam.get(c.team)?.expectedEntries ?? 0;
      case "overlap":
        return c.expectedPickOverlap;
      case "relativeFV":
        return rfvByTeam.get(c.team)?.relativeFutureValue ?? 0;
      case "poolWin":
        return c.poolWinProbability;
      case "equity":
        return c.expectedPrizeEquity;
    }
  };

  const rows = [...candidates].sort((a, b) => (value(a, sort.key) - value(b, sort.key)) * sort.dir);

  const robustnessFor = (team: string) => {
    if (!sensitivity) return null;
    const wins = sensitivity.scenarios.filter((s) => s.bestTeam === team).length;
    return { wins, total: sensitivity.scenarios.length };
  };

  const toggle = (key: SortKey | null) => {
    if (!key) return;
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Candidate rankings — survival and pool equity</CardTitle>
        <span className="text-[11px] text-ink-500">
          Ranked by {objective === "EXPECTED_PRIZE_EQUITY" ? "expected prize equity" : "pool win probability"}
        </span>
      </CardHeader>
      <CardContent className="px-0 pb-3">
        <div className="scroll-x">
          <table className="w-full min-w-[1180px] border-collapse text-sm">
            <thead>
              <tr className="border-y border-ink-800 text-[10px] uppercase tracking-wider text-ink-400">
                {COLUMNS.map((c) => (
                  <th
                    key={c.label}
                    onClick={() => toggle(c.key)}
                    className={cn(
                      "px-3 py-2 font-semibold",
                      c.align === "right" ? "text-right" : "text-left",
                      c.key && "cursor-pointer select-none hover:text-ink-200",
                      c.key && sort.key === c.key && "text-accent",
                    )}
                  >
                    {c.hint ? (
                      <Hint content={c.hint}>
                        <span>{c.label}</span>
                      </Hint>
                    ) : (
                      c.label
                    )}
                    {c.key && sort.key === c.key ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-semibold">Robustness</th>
                <th className="px-3 py-2 text-left font-semibold">Marker</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c, i) => {
                const s = survivalByTeam.get(c.team);
                const own = ownershipByTeam.get(c.team);
                const rfv = rfvByTeam.get(c.team);
                const rob = robustnessFor(c.team);
                const isNaive = c.team === naivePick;
                const isPool = c.team === poolPick;
                return (
                  <tr
                    key={c.team}
                    className={cn(
                      "border-b border-ink-850 transition-colors hover:bg-ink-850/50",
                      isPool && "bg-violet/[0.07]",
                    )}
                  >
                    <td className="tabular px-3 py-2 text-ink-500">{i + 1}</td>
                    <td className="px-3 py-2 font-semibold text-ink-100">{c.team}</td>
                    <td className="px-3 py-2 text-xs text-ink-500">
                      {c.isHome ? "vs" : "@"} {c.opponent}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-100">
                      {pct(c.currentWinProbability)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(s?.pathSurvival[horizonKey])}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(own?.share ?? 0, 0)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {(own?.expectedEntries ?? 0).toFixed(2)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {c.expectedPickOverlap.toFixed(2)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {(rfv?.relativeFutureValue ?? 0).toFixed(3)}
                    </td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right",
                        objective !== "EXPECTED_PRIZE_EQUITY"
                          ? "font-semibold text-ink-100"
                          : "text-ink-300",
                      )}
                    >
                      {pct(c.poolWinProbability)}
                    </td>
                    <td
                      className={cn(
                        "tabular px-3 py-2 text-right",
                        objective === "EXPECTED_PRIZE_EQUITY"
                          ? "font-semibold text-ink-100"
                          : "text-ink-300",
                      )}
                    >
                      {pct(c.expectedPrizeEquity)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-400">
                      {rob ? `${rob.wins}/${rob.total}` : "—"}
                    </td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">
                        {isNaive ? <Badge tone="accent">NAIVE PICK</Badge> : null}
                        {isPool ? <Badge tone="violet">POOL-EQUITY PICK</Badge> : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        <p className="px-5 pt-3 text-[11px] leading-relaxed text-ink-500">
          Pool win probability and expected prize equity are simulation frequencies, not scores.
          Projected ownership, expected overlap and relative future value are explanation metrics —
          they inform the simulation but never rank the table directly.
        </p>
      </CardContent>
    </Card>
  );
}
