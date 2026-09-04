"use client";

import * as React from "react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey } from "@/lib/types";
import { teamName } from "@/lib/teams";
import { cn, pct, probColor } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle, Tabs } from "./ui";

export function PathPlanner({
  snapshot,
  horizon,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
}) {
  // Defaults to the active horizon so the first step always matches the
  // headline recommendation; the season view is one click away.
  const [view, setView] = React.useState<"horizon" | "season">("horizon");
  const steps = view === "season" ? snapshot.seasonPath : snapshot.optimalPath;
  const survival = view === "season" ? snapshot.seasonSurvival : snapshot.horizonSurvival;

  const horizonFirst = snapshot.optimalPath[0]?.team ?? null;
  const seasonFirst = snapshot.seasonPath[0]?.team ?? null;
  const firstDiffers =
    horizonFirst != null && seasonFirst != null && horizonFirst !== seasonFirst;

  const chartData = steps.map((s) => ({
    week: `W${s.week}`,
    cumulative: Number((s.cumulative * 100).toFixed(2)),
    weekly: Number((s.probability * 100).toFixed(1)),
    team: s.team,
  }));

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-3">
        <CardTitle>Optimal survival path</CardTitle>
        <Tabs
          size="sm"
          value={view}
          onValueChange={(v) => setView(v as "horizon" | "season")}
          options={[
            { value: "horizon", label: horizon === "season" ? "Horizon" : `${horizon} weeks` },
            { value: "season", label: "Rest of season" },
          ]}
        />
      </CardHeader>
      <CardContent className="space-y-4">
        {firstDiffers ? (
          <p className="rounded-lg border border-accent/25 bg-accent/5 p-2.5 text-[11px] leading-relaxed text-ink-200">
            Over the rest of the season the optimiser would start with{" "}
            <span className="font-semibold text-accent">{seasonFirst}</span> rather than{" "}
            <span className="font-semibold text-accent">{horizonFirst}</span>. That is the horizon
            trade-off, not a contradiction: the season view weights far-future matchups the
            medium horizon deliberately discounts.
          </p>
        ) : null}

        <div className="flex flex-wrap items-baseline gap-x-6 gap-y-1">
          <span className="text-sm text-ink-300">
            Cumulative survival:{" "}
            <span className="tabular text-lg font-semibold text-accent">
              {pct(survival, survival < 0.05 ? 2 : 1)}
            </span>
          </span>
          <span className="text-xs text-ink-500">
            {steps.length} week{steps.length === 1 ? "" : "s"} planned, each team used at most once
          </span>
        </div>

        {chartData.length > 1 ? (
          <div className="h-40 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 6, right: 8, bottom: 0, left: -18 }}>
                <CartesianGrid stroke="#1e2739" strokeDasharray="2 4" />
                <XAxis
                  dataKey="week"
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={{ stroke: "#2a344a" }}
                  tickLine={false}
                />
                <YAxis
                  tick={{ fill: "#64748b", fontSize: 10 }}
                  axisLine={false}
                  tickLine={false}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  contentStyle={{
                    background: "#111725",
                    border: "1px solid #2a344a",
                    borderRadius: 8,
                    fontSize: 12,
                  }}
                  labelStyle={{ color: "#94a3b8" }}
                  formatter={(value: number, name: string) => [
                    `${value}%`,
                    name === "cumulative" ? "Cumulative survival" : "That week",
                  ]}
                />
                <Line
                  type="monotone"
                  dataKey="cumulative"
                  stroke="#62b6ff"
                  strokeWidth={2}
                  dot={{ r: 2, fill: "#62b6ff" }}
                />
                <Line
                  type="monotone"
                  dataKey="weekly"
                  stroke="#a78bfa"
                  strokeWidth={1.5}
                  strokeDasharray="3 3"
                  dot={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        ) : null}

        <div className="scroll-x -mx-1">
          <table className="w-full min-w-[420px] text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="px-1 py-1.5 text-left">Week</th>
                <th className="px-1 py-1.5 text-left">Team</th>
                <th className="px-1 py-1.5 text-left">Opponent</th>
                <th className="px-1 py-1.5 text-right">Win %</th>
                <th className="px-1 py-1.5 text-right">Cumulative</th>
              </tr>
            </thead>
            <tbody>
              {steps.map((s) => {
                const confirmed = snapshot.picks.find(
                  (p) => p.week === s.week && p.confirmed && p.team === s.team,
                );
                return (
                  <tr key={s.week} className="border-b border-ink-850/70">
                    <td className="tabular px-1 py-1.5 text-ink-400">W{s.week}</td>
                    <td className="px-1 py-1.5">
                      <span className="font-semibold text-ink-100">{s.team}</span>
                      {confirmed ? (
                        <Badge tone="good" className="ml-2">
                          Locked
                        </Badge>
                      ) : null}
                    </td>
                    <td className="px-1 py-1.5 text-xs text-ink-400">
                      {s.isHome ? "vs" : "at"} {teamName(s.opponent)}
                    </td>
                    <td className="px-1 py-1.5 text-right">
                      <span
                        className={cn("tabular rounded px-1.5 py-0.5 text-xs font-semibold")}
                        style={{
                          background: probColor(s.probability),
                          color: s.probability > 0.6 ? "#0c1018" : "#e8eefc",
                        }}
                      >
                        {pct(s.probability)}
                      </span>
                    </td>
                    <td className="tabular px-1 py-1.5 text-right text-ink-300">
                      {pct(s.cumulative, s.cumulative < 0.05 ? 2 : 1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        <p className="rounded-lg border border-warn/25 bg-warn/5 p-3 text-[11px] leading-relaxed text-warn/90">
          These future selections are <strong>plans, not picks</strong>. Nothing beyond the current
          week is committed, and the whole path is recomputed every week as results, lines and
          injuries arrive. Only pressing &ldquo;Confirm&rdquo; makes a team unavailable.
        </p>
      </CardContent>
    </Card>
  );
}
