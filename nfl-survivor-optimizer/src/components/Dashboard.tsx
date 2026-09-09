"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey } from "@/lib/types";
import { HeaderBar } from "./HeaderBar";
import { RecommendationCard } from "./RecommendationCard";
import { ExplanationPanel } from "./ExplanationPanel";
import { HorizonPanel } from "./HorizonPanel";
import { RankingsTable } from "./RankingsTable";
import { SeasonHeatmap } from "./SeasonHeatmap";
import { PathPlanner } from "./PathPlanner";
import { PickHistoryPanel } from "./PickHistoryPanel";
import { InjuryPanel } from "./InjuryPanel";
import { DataStatusPanel } from "./DataStatusPanel";
import { RobustnessPanel } from "./RobustnessPanel";
import { PoolStrategyPanel } from "./PoolStrategyPanel";
import { PoolEquityView } from "./gametheory/PoolEquityView";
import { Card, CardContent, CardHeader, CardTitle } from "./ui";

export function Dashboard({ initial }: { initial: AnalysisSnapshot }) {
  const [snapshot, setSnapshot] = React.useState(initial);
  const [horizon, setHorizon] = React.useState<HorizonKey>(
    (String(initial.settings.defaultHorizon) as HorizonKey) ?? "6",
  );
  const [busy, setBusy] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(
    async (h: HorizonKey = horizon) => {
      const res = await fetch(`/api/analysis?horizon=${h}`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Failed to reload analysis");
      setSnapshot(json as AnalysisSnapshot);
    },
    [horizon],
  );

  const withBusy = React.useCallback(
    async (label: string, fn: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await fn();
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const onRefresh = () =>
    withBusy("refresh", async () => {
      const res = await fetch("/api/refresh", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ force: true }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Refresh failed");
      await reload();
    });

  const onHorizonChange = (h: HorizonKey) =>
    withBusy("horizon", async () => {
      setHorizon(h);
      await reload(h);
    });

  const onConfirm = (week: number, team: string, force = false) =>
    withBusy(`confirm:${team}`, async () => {
      const res = await fetch("/api/picks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ week, team, confirmed: true, force }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not confirm pick");
      await reload();
    });

  const onDeletePick = (week: number) =>
    withBusy(`delete:${week}`, async () => {
      const res = await fetch(`/api/picks?week=${week}`, { method: "DELETE" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not remove pick");
      await reload();
    });

  const best = snapshot.candidates[0] ?? null;

  return (
    <div className="space-y-4">
      <HeaderBar
        snapshot={snapshot}
        busy={busy}
        onRefresh={onRefresh}
        horizon={horizon}
        onHorizonChange={onHorizonChange}
      />

      {error ? (
        <Card className="border-bad/50 bg-bad/5">
          <CardContent className="flex items-start gap-3 pt-4 text-sm text-bad">
            <span className="font-semibold">Error</span>
            <span className="text-ink-200">{error}</span>
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]">
        <div className="space-y-4">
          {best ? (
            <RecommendationCard
              snapshot={snapshot}
              candidate={best}
              horizon={horizon}
              busy={busy}
              onConfirm={onConfirm}
            />
          ) : (
            <Card>
              <CardHeader>
                <CardTitle>No eligible team</CardTitle>
              </CardHeader>
              <CardContent className="text-sm text-ink-300">
                Every team is either already used, on bye, or has already kicked off for week{" "}
                {snapshot.recommendationWeek}.
              </CardContent>
            </Card>
          )}
          <ExplanationPanel snapshot={snapshot} horizon={horizon} />
        </div>

        <div className="space-y-4">
          <HorizonPanel snapshot={snapshot} horizon={horizon} onHorizonChange={onHorizonChange} />
          <RobustnessPanel snapshot={snapshot} horizon={horizon} />
          <DataStatusPanel snapshot={snapshot} />
        </div>
      </div>

      {/* The pool-equity optimizer sits alongside the survival optimizer, never
          replacing it. Both recommendations stay visible so they can be compared. */}
      <PoolEquityView snapshot={snapshot} horizonKey={horizon} />

      <RankingsTable
        snapshot={snapshot}
        horizon={horizon}
        busy={busy}
        onConfirm={onConfirm}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PathPlanner snapshot={snapshot} horizon={horizon} />
        <InjuryPanel snapshot={snapshot} />
      </div>

      <SeasonHeatmap snapshot={snapshot} />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <PickHistoryPanel snapshot={snapshot} busy={busy} onDelete={onDeletePick} />
        <PoolStrategyPanel snapshot={snapshot} horizon={horizon} />
      </div>
    </div>
  );
}
