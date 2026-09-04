"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { CandidateEvaluation, HorizonKey, TeamWeekSlot } from "@/lib/types";
import { TEAM_ABBRS, teamName } from "@/lib/teams";
import { cn, confidenceClass, ml, pct, signed, UNAVAILABLE_LABEL } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Hint, Input } from "./ui";

type SortKey =
  | "rank"
  | "team"
  | "final"
  | "market"
  | "model"
  | "spread"
  | "future"
  | "p3"
  | "p6"
  | "season";

const COLUMNS: { key: SortKey; label: string; hint?: string; align?: "left" | "right" }[] = [
  { key: "rank", label: "#", align: "left" },
  { key: "team", label: "Team", align: "left" },
  { key: "final", label: "Final win %", align: "right", hint: "Blended market + model estimate for this week." },
  { key: "market", label: "Market %", align: "right", hint: "Multi-book consensus after removing the vig." },
  { key: "model", label: "Model %", align: "right", hint: "Elo + EPA + situation, injuries included." },
  { key: "spread", label: "Spread", align: "right" },
  { key: "future", label: "Future value", align: "right", hint: "Season log-probability given up by spending this team now. Lower is cheaper." },
  { key: "p3", label: "3-wk path", align: "right" },
  { key: "p6", label: "6-wk path", align: "right" },
  { key: "season", label: "Season path", align: "right" },
];

function candidateValue(c: CandidateEvaluation, key: SortKey): number | string {
  switch (key) {
    case "team":
      return c.team;
    case "final":
      return c.currentWinProb;
    case "market":
      return c.marketProb ?? -1;
    case "model":
      return c.modelProb;
    case "spread":
      return 0;
    case "future":
      return -c.futureValueCost;
    case "p3":
      return c.pathSurvival["3"] ?? 0;
    case "p6":
      return c.pathSurvival["6"] ?? 0;
    case "season":
      return c.pathSurvival["season"] ?? 0;
    default:
      return c.recommendationScore;
  }
}

export function RankingsTable({
  snapshot,
  horizon,
  busy,
  onConfirm,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
  busy: string | null;
  onConfirm: (week: number, team: string, force?: boolean) => void;
}) {
  const [sort, setSort] = React.useState<{ key: SortKey; dir: 1 | -1 }>({ key: "rank", dir: -1 });
  const [filter, setFilter] = React.useState("");
  const [showIneligible, setShowIneligible] = React.useState(true);

  const week = snapshot.recommendationWeek;
  const byTeam = new Map(snapshot.candidates.map((c) => [c.team, c]));
  const slotByTeam = new Map<string, TeamWeekSlot>(
    snapshot.slots.filter((s) => s.week === week).map((s) => [s.team, s]),
  );

  const rows = React.useMemo(() => {
    const eligible = [...snapshot.candidates];
    eligible.sort((a, b) => {
      const av = candidateValue(a, sort.key);
      const bv = candidateValue(b, sort.key);
      if (typeof av === "string" || typeof bv === "string") {
        return String(av).localeCompare(String(bv)) * (sort.dir === 1 ? 1 : -1) * -1;
      }
      return (av - bv) * sort.dir;
    });
    return eligible;
  }, [snapshot.candidates, sort]);

  const ineligible = TEAM_ABBRS.filter((t) => !byTeam.has(t))
    .map((t) => ({ team: t, slot: slotByTeam.get(t) }))
    .filter((x) => !filter || x.team.toLowerCase().includes(filter.toLowerCase()));

  const filtered = rows.filter(
    (c) =>
      !filter ||
      c.team.toLowerCase().includes(filter.toLowerCase()) ||
      teamName(c.team).toLowerCase().includes(filter.toLowerCase()),
  );

  const toggle = (key: SortKey) =>
    setSort((s) => (s.key === key ? { key, dir: (s.dir * -1) as 1 | -1 } : { key, dir: -1 }));

  const injuryFor = (team: string) =>
    (snapshot.injuriesByTeam[team] ?? []).filter(
      (i) => i.impact === "CRITICAL" || i.impact === "HIGH",
    );

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Week {week} rankings — all 32 teams</CardTitle>
        <div className="flex items-center gap-2">
          <Input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter teams…"
            className="h-8 w-40 text-xs"
          />
          <Button
            size="sm"
            variant={showIneligible ? "outline" : "ghost"}
            onClick={() => setShowIneligible((v) => !v)}
          >
            {showIneligible ? "Hide" : "Show"} unavailable ({TEAM_ABBRS.length - snapshot.candidates.length})
          </Button>
        </div>
      </CardHeader>
      <CardContent className="px-0 pb-3">
        <div className="scroll-x">
          <table className="w-full min-w-[1180px] border-collapse text-sm">
            <thead>
              <tr className="border-y border-ink-800 text-[10px] uppercase tracking-wider text-ink-400">
                {COLUMNS.map((c) => (
                  <th
                    key={c.key}
                    onClick={() => toggle(c.key)}
                    className={cn(
                      "cursor-pointer select-none px-3 py-2 font-semibold hover:text-ink-200",
                      c.align === "right" ? "text-right" : "text-left",
                      sort.key === c.key && "text-accent",
                    )}
                  >
                    {c.hint ? (
                      <Hint content={c.hint}>
                        <span>{c.label}</span>
                      </Hint>
                    ) : (
                      c.label
                    )}
                    {sort.key === c.key ? (sort.dir === -1 ? " ↓" : " ↑") : ""}
                  </th>
                ))}
                <th className="px-3 py-2 text-left font-semibold">Key injuries</th>
                <th className="px-3 py-2 text-left font-semibold">Recommendation</th>
                <th className="px-3 py-2" />
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => {
                const p = snapshot.probabilities.find(
                  (x) => x.gameId === c.gameId && x.team === c.team,
                );
                const inj = injuryFor(c.team);
                return (
                  <tr
                    key={c.team}
                    className={cn(
                      "border-b border-ink-850 transition-colors hover:bg-ink-850/50",
                      i === 0 && sort.key === "rank" && "bg-accent/[0.06]",
                    )}
                  >
                    <td className="tabular px-3 py-2 text-ink-500">{i + 1}</td>
                    <td className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-ink-100">{c.team}</span>
                        <span className="text-xs text-ink-500">
                          {c.isHome ? "vs" : "@"} {c.opponent}
                        </span>
                        <span
                          className={cn(
                            "rounded border px-1 py-px text-[9px] font-semibold uppercase",
                            confidenceClass(c.confidence),
                          )}
                        >
                          {c.confidence[0]}
                        </span>
                        {p?.manualOverride ? <Badge tone="violet">Manual</Badge> : null}
                      </div>
                    </td>
                    <td className="tabular px-3 py-2 text-right font-semibold text-ink-100">
                      {pct(c.currentWinProb)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(c.marketProb)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">{pct(c.modelProb)}</td>
                    <td className="tabular px-3 py-2 text-right text-ink-400">
                      {p?.spread != null ? signed(p.spread) : ml(p?.moneyline)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {c.futureValueCost.toFixed(3)}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(c.pathSurvival["3"])}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(c.pathSurvival["6"])}
                    </td>
                    <td className="tabular px-3 py-2 text-right text-ink-300">
                      {pct(c.pathSurvival["season"], 2)}
                    </td>
                    <td className="px-3 py-2 text-xs text-ink-400">
                      {inj.length === 0 ? (
                        <span className="text-ink-600">—</span>
                      ) : (
                        inj
                          .slice(0, 2)
                          .map((x) => `${x.playerName} (${x.position}, ${x.status})`)
                          .join("; ")
                      )}
                    </td>
                    <td className="px-3 py-2">
                      <Badge
                        tone={
                          c.verdict === "BEST PICK"
                            ? "accent"
                            : c.verdict === "PRESERVE"
                              ? "violet"
                              : c.verdict === "AVOID"
                                ? "bad"
                                : "neutral"
                        }
                      >
                        {c.verdict}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy != null}
                        onClick={() => onConfirm(week, c.team)}
                      >
                        Confirm
                      </Button>
                    </td>
                  </tr>
                );
              })}

              {showIneligible
                ? ineligible.map(({ team, slot }) => (
                    <tr key={team} className="border-b border-ink-850 bg-ink-950/60 text-ink-600">
                      <td className="px-3 py-1.5" />
                      <td className="px-3 py-1.5">
                        <span className="font-medium line-through decoration-ink-700">{team}</span>
                      </td>
                      <td colSpan={9} className="px-3 py-1.5 text-xs">
                        {slot?.reason ? UNAVAILABLE_LABEL[slot.reason] : "Unavailable"}
                        {slot?.probability
                          ? ` — ${slot.probability.isHome ? "vs" : "@"} ${slot.probability.opponent}`
                          : ""}
                      </td>
                      <td className="px-3 py-1.5">
                        <Badge tone={slot?.reason === "USED" ? "bad" : "neutral"}>
                          {slot?.reason ?? "N/A"}
                        </Badge>
                      </td>
                      <td className="px-3 py-1.5" />
                    </tr>
                  ))
                : null}
            </tbody>
          </table>
        </div>
        <p className="px-5 pt-3 text-[11px] leading-relaxed text-ink-500">
          Path columns are the optimised survival probability of the whole horizon <em>given</em>{" "}
          that team is used this week — not the team&apos;s own win probability. Sorting by{" "}
          {horizon === "season" ? "Season path" : `${horizon}-wk path`} reproduces the
          recommendation ordering. Greyed rows are hard-excluded: already used, on bye, no game, or
          already kicked off.
        </p>
      </CardContent>
    </Card>
  );
}
