"use client";

import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey } from "@/lib/types";
import { humanizeAge } from "@/lib/clock";
import { Badge, Button, Spinner, Tabs } from "./ui";
import { teamShort } from "@/lib/teams";

const HORIZONS: { value: HorizonKey; label: string }[] = [
  { value: "3", label: "3 wk" },
  { value: "6", label: "6 wk" },
  { value: "9", label: "9 wk" },
  { value: "season", label: "Season" },
];

export function HeaderBar({
  snapshot,
  busy,
  onRefresh,
  horizon,
  onHorizonChange,
}: {
  snapshot: AnalysisSnapshot;
  busy: string | null;
  onRefresh: () => void;
  horizon: HorizonKey;
  onHorizonChange: (h: HorizonKey) => void;
}) {
  const used = snapshot.usedTeams;
  return (
    <header className="rounded-xl border border-ink-700 bg-ink-900/70 px-5 py-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-3">
            <h1 className="text-xl font-semibold tracking-tight text-ink-100">
              NFL Survivor Optimizer
            </h1>
            <span className="text-sm text-ink-400">{snapshot.season} regular season</span>
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-x-5 gap-y-1 text-sm text-ink-300">
            <span>
              <span className="text-ink-500">Week</span>{" "}
              <span className="tabular font-semibold text-ink-100">
                {snapshot.recommendationWeek}
              </span>
              {snapshot.recommendationWeek !== snapshot.currentWeek ? (
                <span className="ml-1 text-xs text-ink-500">
                  (week {snapshot.currentWeek} already confirmed)
                </span>
              ) : null}
            </span>
            <span>
              <span className="text-ink-500">Teams remaining</span>{" "}
              <span className="tabular font-semibold text-ink-100">{snapshot.teamsRemaining}</span>
            </span>
            <span>
              <span className="text-ink-500">Teams used</span>{" "}
              <span className="tabular font-semibold text-ink-100">{used.length}</span>
              {used.length > 0 ? (
                <span className="ml-2 text-xs text-ink-500">
                  {used.map((t) => teamShort(t)).join(", ")}
                </span>
              ) : null}
            </span>
            {snapshot.byeTeams.length > 0 ? (
              <span className="text-xs text-ink-500">
                On bye: {snapshot.byeTeams.join(", ")}
              </span>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {snapshot.degraded ? (
            <Badge tone="warn" title="At least one provider failed or is serving reduced data">
              Degraded data
            </Badge>
          ) : (
            <Badge tone="good">All providers OK</Badge>
          )}
          {snapshot.modelInfo.isFallback ? (
            <Badge tone="warn">Untrained model</Badge>
          ) : null}
          <Tabs
            value={horizon}
            onValueChange={(v) => onHorizonChange(v as HorizonKey)}
            options={HORIZONS}
            size="sm"
          />
          <Button variant="primary" size="sm" onClick={onRefresh} disabled={busy === "refresh"}>
            {busy === "refresh" ? <Spinner /> : null}
            {busy === "refresh" ? "Refreshing…" : "Refresh Data"}
          </Button>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-ink-500">
        Analysis generated {humanizeAge(snapshot.generatedAt, new Date(snapshot.generatedAt))} ·{" "}
        {snapshot.modelInfo.gamesProcessed} completed {snapshot.season} games folded into the
        ratings
        {snapshot.modelInfo.lastCompletedWeek > 0
          ? ` (through week ${snapshot.modelInfo.lastCompletedWeek})`
          : " (preseason priors)"}
      </div>
    </header>
  );
}
