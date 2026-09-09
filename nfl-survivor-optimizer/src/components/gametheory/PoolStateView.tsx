"use client";

import * as React from "react";
import Link from "next/link";
import type { EntryState, InventoryEdge } from "@/lib/gametheory/types";
import type { EntryBehaviorSummary } from "@/lib/gametheory/context";
import type { PoolEquityAnalysis } from "@/lib/gametheory/poolEquity";
import { PoolStateTable, InventoryEdgeTable } from "./PoolStateTable";
import { FieldInventoryHeatmap } from "./FieldInventoryHeatmap";
import { EntryInspector } from "./EntryInspector";
import { AddEntryPanel, EntryImportPanel } from "./EntryImportPanel";
import { Button, Card, CardContent, Spinner } from "../ui";

interface EntriesResponse {
  season: number;
  week: number;
  entries: EntryState[];
  inventoryEdges: InventoryEdge[];
  totals: { original: number; active: number; eliminated: number };
}

export function PoolStateView({
  initial,
  weeks,
}: {
  initial: EntriesResponse;
  weeks: number[];
}) {
  const [data, setData] = React.useState(initial);
  const [selectedId, setSelectedId] = React.useState<string | null>(
    initial.entries.find((e) => !e.entry.isUser)?.entry.id ?? null,
  );
  const [analysis, setAnalysis] = React.useState<PoolEquityAnalysis | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const reload = React.useCallback(async () => {
    const res = await fetch("/api/entries", { cache: "no-store" });
    const json = await res.json();
    if (res.ok) setData(json as EntriesResponse);
  }, []);

  const loadPredictions = React.useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      // A light run: predictions and inventory only, no sensitivity sweep.
      const res = await fetch("/api/pool-equity?simulations=1000&sensitivity=0", {
        cache: "no-store",
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not load predictions");
      setAnalysis(json.analysis as PoolEquityAnalysis);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const setKnownPick = async (entryId: string, team: string | null) => {
    setBusy(true);
    setError(null);
    try {
      const res = team
        ? await fetch("/api/entries/picks", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ entryId, week: data.week, team, isKnown: true }),
          })
        : await fetch(`/api/entries/picks?entryId=${entryId}&week=${data.week}`, {
            method: "DELETE",
          });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Could not save pick");
      await reload();
      if (analysis) await loadPredictions();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selected = data.entries.find((e) => e.entry.id === selectedId) ?? null;
  const behavior: EntryBehaviorSummary | null =
    analysis?.entryBehavior.find((b) => b.entryId === selectedId) ?? null;
  const distribution =
    analysis?.currentDistributions.find((d) => d.entryId === selectedId) ?? null;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Pool state — {data.season}, week {data.week}
        </h1>
        <div className="flex items-center gap-2">
          <Button size="sm" variant="outline" onClick={loadPredictions} disabled={busy}>
            {busy ? <Spinner /> : null}
            {analysis ? "Refresh predictions" : "Load predicted picks"}
          </Button>
          <Link href="/" className="text-xs text-accent hover:underline">
            ← Dashboard
          </Link>
        </div>
      </div>

      {error ? (
        <Card className="border-bad/40">
          <CardContent className="pt-4 text-sm text-bad">{error}</CardContent>
        </Card>
      ) : null}

      <PoolStateTable
        entries={data.entries}
        weeks={weeks}
        currentWeek={data.week}
        onSelect={setSelectedId}
        selectedId={selectedId}
        onRefresh={reload}
      />

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <EntryInspector
          state={selected}
          behavior={behavior}
          distribution={distribution}
          currentWeek={data.week}
          onKnownPick={setKnownPick}
          busy={busy}
        />
        <div className="space-y-4">
          <EntryImportPanel onImported={reload} />
          <AddEntryPanel onAdded={reload} />
        </div>
      </div>

      <FieldInventoryHeatmap entries={data.entries} />
      <InventoryEdgeTable edges={data.inventoryEdges} />
    </div>
  );
}
