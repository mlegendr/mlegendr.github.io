"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { TeamWeekSlot } from "@/lib/types";
import { TEAM_ABBRS, teamName } from "@/lib/teams";
import { cn, pct, probColor, UNAVAILABLE_LABEL } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle } from "./ui";

type Grouping = "alphabetical" | "division" | "value";

/**
 * The season grid: rows are teams, columns are weeks, cells are win probability.
 *
 * This is the view that makes "save Buffalo for weeks 8-11" visible at a glance —
 * the optimiser's planned path is overlaid on top of the raw probabilities.
 */
export function SeasonHeatmap({ snapshot }: { snapshot: AnalysisSnapshot }) {
  const [grouping, setGrouping] = React.useState<Grouping>("value");
  const [hover, setHover] = React.useState<TeamWeekSlot | null>(null);
  const [showPath, setShowPath] = React.useState(true);

  const weeks = snapshot.weeks;
  const slotMap = new Map<string, TeamWeekSlot>();
  for (const s of snapshot.slots) slotMap.set(`${s.team}:${s.week}`, s);

  const pathCells = new Set(
    (showPath ? snapshot.seasonPath : []).map((s) => `${s.team}:${s.week}`),
  );

  const teams = React.useMemo(() => {
    const list = [...TEAM_ABBRS];
    if (grouping === "alphabetical") return list.sort();
    if (grouping === "value") {
      const score = (t: string) => {
        let acc = 0;
        for (const w of weeks) {
          const p = slotMap.get(`${t}:${w}`)?.probability;
          if (p && !p.completed) acc += p.finalProb;
        }
        return acc;
      };
      return list.sort((a, b) => score(b) - score(a));
    }
    return list.sort((a, b) => {
      const A = teamName(a);
      const B = teamName(b);
      return A.localeCompare(B);
    });
    // slotMap is derived from snapshot each render; weeks is stable per snapshot.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [grouping, snapshot]);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Season heatmap — predicted win probability by week</CardTitle>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant={showPath ? "outline" : "ghost"}
            onClick={() => setShowPath((v) => !v)}
          >
            {showPath ? "Hide" : "Show"} optimal path
          </Button>
          <select
            value={grouping}
            onChange={(e) => setGrouping(e.target.value as Grouping)}
            className="h-8 rounded-lg border border-ink-600 bg-ink-850 px-2 text-xs text-ink-100"
          >
            <option value="value">Sort by remaining value</option>
            <option value="alphabetical">Sort alphabetically</option>
            <option value="division">Sort by full name</option>
          </select>
        </div>
      </CardHeader>
      <CardContent className="px-0">
        <div className="scroll-x px-5">
          <table className="border-separate border-spacing-[2px]">
            <thead>
              <tr>
                <th className="sticky left-0 z-10 bg-ink-900 px-1 text-left text-[10px] font-semibold uppercase tracking-wider text-ink-500">
                  Team
                </th>
                {weeks.map((w) => (
                  <th
                    key={w}
                    className={cn(
                      "w-9 text-center text-[10px] font-semibold",
                      w === snapshot.recommendationWeek ? "text-accent" : "text-ink-500",
                    )}
                  >
                    {w}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team}>
                  <td
                    className={cn(
                      "sticky left-0 z-10 bg-ink-900 pr-2 text-[11px] font-semibold",
                      snapshot.usedTeams.includes(team)
                        ? "text-ink-600 line-through decoration-ink-700"
                        : "text-ink-200",
                    )}
                  >
                    {team}
                  </td>
                  {weeks.map((w) => {
                    const slot = slotMap.get(`${team}:${w}`);
                    const p = slot?.probability ?? null;
                    const onPath = pathCells.has(`${team}:${w}`);
                    const unavailable = slot?.reason;
                    const label =
                      unavailable === "BYE" || unavailable === "NO_GAME"
                        ? "—"
                        : p
                          ? Math.round(p.finalProb * 100)
                          : "";
                    return (
                      <td key={w} className="p-0">
                        <div
                          onMouseEnter={() => slot && setHover(slot)}
                          onMouseLeave={() => setHover(null)}
                          className={cn(
                            "tabular grid h-6 w-9 cursor-default place-items-center rounded text-[10px] font-semibold transition-transform",
                            onPath && "ring-2 ring-accent ring-offset-1 ring-offset-ink-900",
                            unavailable === "USED" && "opacity-25",
                            (unavailable === "BYE" || unavailable === "NO_GAME") &&
                              "bg-ink-850 text-ink-600",
                            unavailable === "COMPLETED" && "opacity-70",
                            unavailable === "LOCKED_PICK" && "ring-2 ring-good",
                          )}
                          style={
                            unavailable === "BYE" || unavailable === "NO_GAME" || !p
                              ? undefined
                              : {
                                  background: probColor(p.finalProb),
                                  color: p.finalProb > 0.6 ? "#0c1018" : "#e8eefc",
                                }
                          }
                          title={
                            p
                              ? `${team} ${p.isHome ? "vs" : "@"} ${p.opponent} — ${pct(p.finalProb)}`
                              : UNAVAILABLE_LABEL[unavailable ?? "NO_GAME"]
                          }
                        >
                          {label}
                        </div>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-5 gap-y-2 border-t border-ink-800 px-5 pt-3 text-[11px] text-ink-400">
          <span className="flex items-center gap-1.5">
            {[0.35, 0.5, 0.6, 0.7, 0.8, 0.9].map((v) => (
              <span
                key={v}
                className="grid h-4 w-7 place-items-center rounded text-[9px] font-bold"
                style={{ background: probColor(v), color: v > 0.6 ? "#0c1018" : "#e8eefc" }}
              >
                {Math.round(v * 100)}
              </span>
            ))}
            <span className="ml-1">underdog → strong favourite</span>
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-7 rounded bg-ink-850" /> bye / no game
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-7 rounded bg-ink-700 opacity-25" /> already used
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-7 rounded ring-2 ring-accent" /> optimiser&apos;s planned path
          </span>
          <span className="flex items-center gap-1.5">
            <span className="h-4 w-7 rounded ring-2 ring-good" /> your confirmed pick
          </span>
        </div>

        <div className="min-h-[52px] px-5 pt-3">
          {hover ? (
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-ink-700 bg-ink-850 px-3 py-2 text-xs">
              <span className="font-semibold text-ink-100">
                {teamName(hover.team)} · Week {hover.week}
              </span>
              {hover.probability ? (
                <>
                  <span className="text-ink-300">
                    {hover.probability.isHome ? "vs" : "at"} {teamName(hover.probability.opponent)}
                  </span>
                  <span className="tabular text-ink-100">
                    {pct(hover.probability.finalProb)} win probability
                  </span>
                  <span className="text-ink-400">
                    market {pct(hover.probability.marketProb)} · model{" "}
                    {pct(hover.probability.modelProb)}
                  </span>
                  <Badge tone={hover.probability.marketProb != null ? "accent" : "violet"}>
                    {hover.probability.marketProb != null
                      ? `${hover.probability.bookCount} book${hover.probability.bookCount === 1 ? "" : "s"}`
                      : "model only"}
                  </Badge>
                  <Badge
                    tone={
                      hover.probability.confidence === "HIGH"
                        ? "good"
                        : hover.probability.confidence === "MEDIUM"
                          ? "warn"
                          : "bad"
                    }
                  >
                    {hover.probability.confidence}
                  </Badge>
                </>
              ) : (
                <span className="text-ink-400">
                  {UNAVAILABLE_LABEL[hover.reason ?? "NO_GAME"]}
                </span>
              )}
              {hover.reason ? (
                <Badge tone={hover.reason === "USED" ? "bad" : "neutral"}>{hover.reason}</Badge>
              ) : null}
            </div>
          ) : (
            <p className="text-[11px] text-ink-500">
              Hover any cell for the opponent, home/away, both probability sources and the data
              source behind them.
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
