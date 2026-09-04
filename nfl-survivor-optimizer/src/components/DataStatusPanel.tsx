"use client";

import type { AnalysisSnapshot, DataStatusEntry } from "@/lib/engine";
import { humanizeAge } from "@/lib/clock";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "./ui";

const ORDER = ["schedule", "odds", "injuries", "weather", "stats", "model"];
const TITLES: Record<string, string> = {
  schedule: "Schedule",
  odds: "Odds",
  injuries: "Injuries",
  weather: "Weather",
  stats: "Team stats",
  model: "Team model",
};

function detailLine(entry: DataStatusEntry): string | null {
  const d = entry.detail ?? {};
  const bits: string[] = [];
  if (typeof d.games === "number") bits.push(`${d.games} games`);
  if (typeof d.books === "number" && d.books > 0) bits.push(`${d.books} sportsbooks`);
  if (typeof d.players === "number") bits.push(`${d.players} players`);
  if (typeof d.teamWeeks === "number") bits.push(`${d.teamWeeks} team-weeks`);
  if (typeof d.trainedAt === "string") bits.push(`trained ${d.trainedAt.slice(0, 10)}`);
  return bits.length ? bits.join(" · ") : null;
}

export function DataStatusPanel({ snapshot }: { snapshot: AnalysisSnapshot }) {
  const rows = [...snapshot.dataStatus].sort(
    (a, b) => ORDER.indexOf(a.key) - ORDER.indexOf(b.key),
  );
  const reference = new Date(snapshot.generatedAt);

  return (
    <Card className={snapshot.degraded ? "border-warn/40" : undefined}>
      <CardHeader className="flex items-center justify-between gap-2">
        <CardTitle>Data status</CardTitle>
        {snapshot.degraded ? <Badge tone="warn">Degraded data</Badge> : <Badge tone="good">OK</Badge>}
      </CardHeader>
      <CardContent className="space-y-2.5">
        {rows.length === 0 ? (
          <p className="text-xs text-ink-400">
            No provider has run yet. Press <span className="text-ink-200">Refresh Data</span>.
          </p>
        ) : null}
        {rows.map((r) => (
          <div key={r.key} className="border-b border-ink-800 pb-2 last:border-0 last:pb-0">
            <div className="flex items-baseline justify-between gap-2">
              <span className="text-xs font-semibold text-ink-200">
                {TITLES[r.key] ?? r.key}
              </span>
              {!r.ok ? (
                <Badge tone="bad">Failed</Badge>
              ) : r.degraded ? (
                <Badge tone="warn">Degraded</Badge>
              ) : (
                <Badge tone="good">OK</Badge>
              )}
            </div>
            <div className="mt-0.5 flex flex-wrap items-baseline gap-x-2 text-[11px] text-ink-400">
              <span className="text-ink-300">{r.label}</span>
              <span>·</span>
              <span>
                {r.lastSuccess
                  ? `updated ${humanizeAge(r.lastSuccess, reference)}`
                  : "never succeeded"}
              </span>
              {detailLine(r) ? (
                <>
                  <span>·</span>
                  <span>{detailLine(r)}</span>
                </>
              ) : null}
            </div>
            {r.message ? (
              <div className="mt-1 text-[11px] leading-relaxed text-warn/90">{r.message}</div>
            ) : null}
          </div>
        ))}

        <div className="pt-1 text-[11px] leading-relaxed text-ink-500">
          Configured providers:{" "}
          {Object.entries(snapshot.providerAvailability)
            .filter(([k]) => k !== "offline")
            .map(([k, v]) => `${k}${v ? "" : " (off)"}`)
            .join(", ")}
          {snapshot.providerAvailability.offline ? " · OFFLINE MODE" : ""}
        </div>
      </CardContent>
    </Card>
  );
}
