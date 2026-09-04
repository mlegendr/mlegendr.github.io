"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import { teamName } from "@/lib/teams";
import { cn, impactClass } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle, Tabs } from "./ui";

/**
 * Injuries for the teams actually in contention this week.
 * Deep-roster and special-teams designations are filtered out upstream — a
 * recommendation cluttered with every hamstring is a recommendation nobody reads.
 */
export function InjuryPanel({ snapshot }: { snapshot: AnalysisSnapshot }) {
  const [scope, setScope] = React.useState<"top" | "all">("top");
  const topTeams = new Set(
    snapshot.candidates.slice(0, scope === "top" ? 6 : 32).flatMap((c) => [c.team, c.opponent]),
  );

  const rows = Object.entries(snapshot.injuriesByTeam)
    .filter(([team, list]) => topTeams.has(team) && list.length > 0)
    .map(([team, list]) => ({
      team,
      list: list.filter((i) => i.impact !== "LOW" || i.position === "QB"),
    }))
    .filter((r) => r.list.length > 0)
    .sort(
      (a, b) =>
        Math.max(...b.list.map((i) => i.impactScore)) -
        Math.max(...a.list.map((i) => i.impactScore)),
    );

  const injuryStatus = snapshot.dataStatus.find((d) => d.key === "injuries");

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Injury impact</CardTitle>
        <Tabs
          size="sm"
          value={scope}
          onValueChange={(v) => setScope(v as "top" | "all")}
          options={[
            { value: "top", label: "Top candidates" },
            { value: "all", label: "All teams" },
          ]}
        />
      </CardHeader>
      <CardContent className="space-y-3">
        {injuryStatus && !injuryStatus.ok ? (
          <div className="rounded-lg border border-warn/40 bg-warn/5 p-3 text-xs leading-relaxed text-warn">
            <span className="font-semibold">Injury data unavailable. </span>
            {injuryStatus.message}
            <div className="mt-1 text-warn/80">
              You can still enter injuries by hand on the Settings page — manual entries are
              labelled and supersede provider data.
            </div>
          </div>
        ) : null}

        {rows.length === 0 ? (
          <p className="text-xs text-ink-500">
            No meaningful injuries reported for this week&apos;s candidate teams.
          </p>
        ) : null}

        {rows.map((r) => (
          <div key={r.team} className="rounded-lg border border-ink-700 bg-ink-850/40 p-3">
            <div className="mb-2 flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-ink-100">{teamName(r.team)}</span>
              <span className="text-[10px] uppercase tracking-wider text-ink-500">{r.team}</span>
            </div>
            <ul className="space-y-1.5">
              {r.list.slice(0, 5).map((i, idx) => (
                <li key={idx} className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
                  <span className="font-medium text-ink-100">{i.playerName}</span>
                  <span className="text-ink-500">{i.position}</span>
                  <span className="text-ink-300">{i.status}</span>
                  {i.practiceParticipation ? (
                    <span className="text-ink-500">{i.practiceParticipation}</span>
                  ) : null}
                  <span
                    className={cn(
                      "rounded border px-1.5 py-px text-[9px] font-bold uppercase tracking-wider",
                      impactClass(i.impact),
                    )}
                  >
                    {i.impact}
                  </span>
                  {i.manualOverride ? <Badge tone="violet">Manual override</Badge> : null}
                </li>
              ))}
            </ul>
          </div>
        ))}

        <p className="text-[11px] leading-relaxed text-ink-500">
          Impact is an estimate from position, depth-chart rank and designation — it is not
          precisely known. When the market has updated more recently than the injury news, no extra
          injury penalty is applied on top of the line, because the books have already priced it.
        </p>
      </CardContent>
    </Card>
  );
}
