"use client";

import * as React from "react";
import Link from "next/link";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { PoolEquityAnalysis } from "@/lib/gametheory/poolEquity";
import type { PoolEquityExplanation } from "@/lib/gametheory/explain";
import type { GameTheorySettings, PoolObjective } from "@/lib/gametheory/types";
import { OBJECTIVE_LABEL } from "@/lib/gametheory/types";
import { DualRecommendation } from "./DualRecommendation";
import { PoolEquityRankings } from "./PoolEquityRankings";
import { ConfidencePanel, OwnershipPanel, SensitivityPanel } from "./OwnershipPanel";
import { AdvancedSettingsPanel } from "./AdvancedSettingsPanel";
import { HeadToHeadPanel } from "./HeadToHeadPanel";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Spinner, Switch } from "../ui";

interface RunResponse {
  analysis: PoolEquityAnalysis;
  explanation: PoolEquityExplanation | null;
  objective: PoolObjective;
  settings: GameTheorySettings;
  snapshot?: { created: boolean; id: string } | null;
}

/**
 * The pool-equity half of the dashboard. It never runs automatically: the
 * tournament is the most expensive thing the app does, so it is an explicit
 * action, and the survival optimizer above it is entirely unaffected either way.
 */
export function PoolEquityView({
  snapshot,
  horizonKey,
}: {
  snapshot: AnalysisSnapshot;
  horizonKey: string;
}) {
  const [result, setResult] = React.useState<RunResponse | null>(null);
  const [sims, setSims] = React.useState(20000);
  const [sensitivity, setSensitivity] = React.useState(true);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [saveSnapshot, setSaveSnapshot] = React.useState(false);
  const [snapshotNote, setSnapshotNote] = React.useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    setSnapshotNote(null);
    try {
      const res = await fetch("/api/pool-equity", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ simulations: sims, sensitivity, snapshot: saveSnapshot }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Tournament failed");
      setResult(json as RunResponse);
      if (json.snapshot) {
        setSnapshotNote(
          json.snapshot.created
            ? "Pre-lock snapshot saved for this week."
            : "A pre-lock snapshot already exists for this week and was preserved.",
        );
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const survival = snapshot.candidates[0] ?? null;
  const analysis = result?.analysis ?? null;
  const poolPick = analysis?.tournament.candidates[0] ?? null;
  const survivalTournament =
    survival && analysis
      ? (analysis.tournament.candidates.find((c) => c.team === survival.team) ?? null)
      : null;

  return (
    <div className="space-y-4">
      <Card className="border-violet/30">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3">
          <CardTitle className="text-violet">Pool-equity optimizer (game theory)</CardTitle>
          <div className="flex flex-wrap items-center gap-2">
            <Select
              value={String(sims)}
              onChange={(e) => setSims(Number(e.target.value))}
              className="h-8 text-[11px]"
            >
              <option value="5000">5,000 sims</option>
              <option value="20000">20,000 sims</option>
              <option value="50000">50,000 sims</option>
              <option value="100000">100,000 sims</option>
            </Select>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-400">
              <Switch checked={sensitivity} onCheckedChange={setSensitivity} />
              Sensitivity
            </span>
            <span className="flex items-center gap-1.5 text-[11px] text-ink-400">
              <Switch checked={saveSnapshot} onCheckedChange={setSaveSnapshot} />
              Snapshot
            </span>
            <Button size="sm" variant="primary" onClick={run} disabled={busy}>
              {busy ? <Spinner /> : null} {busy ? "Simulating…" : "Run tournament"}
            </Button>
          </div>
        </CardHeader>
        <CardContent className="space-y-2">
          <p className="text-[11px] leading-relaxed text-ink-500">
            Simulates the whole pool — every active opposing entry&apos;s inventory, its likely
            selection, and each NFL game sampled once so entries on the same team share a fate — to
            estimate how often <em>you</em> end up winning. Manage the field on the{" "}
            <Link href="/pool" className="text-accent hover:underline">
              Pool state
            </Link>{" "}
            page.
          </p>
          {error ? <p className="text-xs text-bad">{error}</p> : null}
          {snapshotNote ? <p className="text-xs text-good">{snapshotNote}</p> : null}
          {analysis ? (
            <div className="flex flex-wrap items-center gap-x-5 gap-y-1 text-[11px] text-ink-400">
              <span>
                Objective:{" "}
                <span className="font-semibold text-violet">
                  {OBJECTIVE_LABEL[result!.objective]}
                </span>
              </span>
              <span>{analysis.tournament.simulations.toLocaleString()} simulations</span>
              <span>seed {analysis.tournament.seed}</span>
              <span>{analysis.tournament.elapsedMs} ms</span>
              <span>{analysis.activeOpponents} active opposing entries</span>
              {analysis.behaviorModel.isColdStart ? (
                <Badge tone="warn">cold-start opponent model</Badge>
              ) : (
                <Badge tone="good">{analysis.behaviorModel.observations} observed decisions</Badge>
              )}
            </div>
          ) : null}
        </CardContent>
      </Card>

      <DualRecommendation
        survival={survival}
        survivalTournament={survivalTournament}
        poolPick={poolPick}
        objective={result?.objective ?? "EXPECTED_PRIZE_EQUITY"}
        explanation={result?.explanation ?? null}
        ownership={analysis?.projectedOwnership ?? []}
        sensitivity={analysis?.sensitivity ?? null}
        activeOpponents={analysis?.activeOpponents ?? 0}
        horizonLabel={horizonKey === "season" ? "Season" : `${horizonKey}-week`}
      />

      {analysis ? (
        <>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
            <OwnershipPanel
              rows={analysis.projectedOwnership}
              activeOpponents={analysis.activeOpponents}
              isColdStart={analysis.behaviorModel.isColdStart}
              note={analysis.behaviorModel.fitNote}
            />
            <div className="space-y-4">
              <ConfidencePanel confidence={analysis.confidence} />
              <MilestonePanel candidate={poolPick} />
            </div>
          </div>

          {analysis.headToHead ? <HeadToHeadPanel data={analysis.headToHead} /> : null}

          <PoolEquityRankings
            candidates={analysis.tournament.candidates}
            survival={snapshot.candidates}
            ownership={analysis.projectedOwnership}
            relativeFutureValue={analysis.relativeFutureValue}
            objective={result!.objective}
            naivePick={survival?.team ?? null}
            poolPick={analysis.tournament.bestTeam}
            sensitivity={analysis.sensitivity}
            horizonKey={horizonKey}
          />

          <SensitivityPanel sensitivity={analysis.sensitivity} objective={result!.objective} />

          <Card>
            <CardHeader>
              <CardTitle>Approximations in this run</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="space-y-1 text-[11px] leading-relaxed text-ink-500">
                {analysis.tournament.approximations.map((a, i) => (
                  <li key={i} className="flex gap-2">
                    <span className="text-ink-700">·</span>
                    <span>{a}</span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </>
      ) : null}

      <AdvancedSettingsPanel initial={result?.settings ?? null} />
    </div>
  );
}

function MilestonePanel({
  candidate,
}: {
  candidate: PoolEquityAnalysis["tournament"]["candidates"][number] | null;
}) {
  if (!candidate) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Milestones</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-500">
          Run the tournament to see how far this pick is expected to carry you.
        </CardContent>
      </Card>
    );
  }
  const weekEntries = Object.entries(candidate.milestones)
    .filter(([k]) => k.startsWith("week"))
    .map(([k, v]) => ({ week: Number(k.replace("week", "")), p: v }))
    .sort((a, b) => a.week - b.week);
  const show = weekEntries.filter((_, i) => i % Math.max(1, Math.floor(weekEntries.length / 6)) === 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Milestones for {candidate.team}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-1.5 text-xs">
        {show.map((m) => (
          <Line key={m.week} label={`Reach week ${m.week}`} value={m.p} />
        ))}
        <Line label="Reach the final 5 entries" value={candidate.milestones.finalFive ?? 0} />
        <Line label="Reach the final 2 entries" value={candidate.milestones.finalTwo ?? 0} />
        <div className="border-t border-ink-800 pt-1.5">
          <Line label="Average finishing position" value={null} raw={candidate.averageFinishingPosition.toFixed(2)} />
          <Line
            label="Median elimination week"
            value={null}
            raw={candidate.medianEliminationWeek == null ? "survives" : `W${candidate.medianEliminationWeek}`}
          />
          <Line
            label="Expected opponents left after this week"
            value={null}
            raw={candidate.expectedOpponentsRemaining.toFixed(2)}
          />
        </div>
      </CardContent>
    </Card>
  );
}

function Line({ label, value, raw }: { label: string; value: number | null; raw?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-ink-400">{label}</span>
      <span className="tabular font-medium text-ink-100">
        {raw ?? (value != null ? `${(value * 100).toFixed(1)}%` : "—")}
      </span>
    </div>
  );
}
