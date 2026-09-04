"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { CandidateEvaluation, HorizonKey } from "@/lib/types";
import { teamName, getTeam } from "@/lib/teams";
import { cn, confidenceClass, pct } from "@/lib/ui";
import { horizonAgreement } from "@/lib/explain";
import { Badge, Button, Card, CardContent, Hint, Spinner, Stat } from "./ui";

export function RecommendationCard({
  snapshot,
  candidate,
  horizon,
  busy,
  onConfirm,
}: {
  snapshot: AnalysisSnapshot;
  candidate: CandidateEvaluation;
  horizon: HorizonKey;
  busy: string | null;
  onConfirm: (week: number, team: string, force?: boolean) => void;
}) {
  const [confirming, setConfirming] = React.useState(false);
  const meta = getTeam(candidate.team);
  const week = snapshot.recommendationWeek;
  const agreement = horizonAgreement(candidate.horizonWinners);
  const robustness =
    candidate.robustnessShare == null
      ? agreement.label
      : candidate.robustnessShare >= 0.5
        ? "HIGH"
        : candidate.robustnessShare >= 0.25
          ? "MEDIUM"
          : "LOW";

  const locked = snapshot.picks.find((p) => p.week === week && p.confirmed);

  return (
    <Card className="overflow-hidden border-accent/30">
      <div
        className="h-1 w-full"
        style={{ background: `linear-gradient(90deg, ${meta.primary}, ${meta.secondary})` }}
      />
      <CardContent className="pt-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-accent">
              Week {week} recommendation
            </div>
            <div className="mt-1 flex items-center gap-3">
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-xs font-bold"
                style={{ background: meta.primary, color: "#fff" }}
              >
                {candidate.team}
              </span>
              <div className="min-w-0">
                <div className="truncate text-2xl font-semibold leading-tight text-ink-100">
                  {teamName(candidate.team)}
                </div>
                <div className="text-sm text-ink-400">
                  {candidate.isHome ? "vs" : "at"} {teamName(candidate.opponent)}
                </div>
              </div>
            </div>
          </div>

          <div className="flex flex-col items-end gap-2">
            <Badge tone="accent">{candidate.verdict}</Badge>
            <span
              className={cn(
                "rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider",
                confidenceClass(candidate.confidence),
              )}
            >
              {candidate.confidence} confidence
            </span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-2 gap-x-6 gap-y-4 sm:grid-cols-3 lg:grid-cols-5">
          <Stat
            label="Current win probability"
            value={pct(candidate.currentWinProb)}
            tone="accent"
            sub="Blended final estimate"
          />
          <Stat
            label="Market probability"
            value={pct(candidate.marketProb)}
            sub={
              candidate.marketProb == null
                ? "no market yet"
                : `${snapshot.probabilities.find((p) => p.gameId === candidate.gameId)?.bookCount ?? 0} book(s), vig removed`
            }
          />
          <Stat label="Model probability" value={pct(candidate.modelProb)} sub="Elo + EPA + situation" />
          <Stat
            label={`${horizon === "season" ? "Season" : `${horizon}-week`} path survival`}
            value={pct(candidate.pathSurvival[horizon])}
            sub="Optimised, no repeats"
          />
          <Stat
            label="Season path survival"
            value={pct(candidate.pathSurvival["season"], 2)}
            sub={`through week ${snapshot.weeks[snapshot.weeks.length - 1]}`}
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-2 border-t border-ink-800 pt-3 text-xs">
          <Hint
            content="Share of Monte Carlo scenarios in which this team is the optimal pick. Not a win probability."
          >
            <span className="text-ink-400">
              Recommendation robustness{" "}
              <span
                className={cn(
                  "font-semibold",
                  robustness === "HIGH"
                    ? "text-good"
                    : robustness === "MEDIUM"
                      ? "text-warn"
                      : "text-bad",
                )}
              >
                {robustness}
              </span>
              {candidate.robustnessShare != null
                ? ` (${pct(candidate.robustnessShare, 0)} of scenarios)`
                : " (horizon agreement)"}
            </span>
          </Hint>
          <Hint content="Log-probability of season survival given up by spending this team now, versus the unconstrained optimum.">
            <span className="text-ink-400">
              Future value cost{" "}
              <span className="tabular font-semibold text-ink-100">
                {candidate.futureValueCost.toFixed(3)}
              </span>
            </span>
          </Hint>
          <span className="text-ink-400">
            Immediate safety{" "}
            <span className="tabular font-semibold text-ink-100">
              {pct(candidate.currentWinProb)}
            </span>
          </span>
          <span className="text-ink-400">
            Recommendation score{" "}
            <span className="tabular font-semibold text-ink-100">
              {candidate.recommendationScore.toFixed(1)}
            </span>
            <span className="text-ink-600"> / 100</span>
          </span>
        </div>

        <div className="mt-4 flex flex-wrap items-center gap-3">
          {locked ? (
            <div className="rounded-lg border border-good/40 bg-good/10 px-3 py-2 text-sm text-good">
              Week {week} is already confirmed as {locked.team}.
            </div>
          ) : confirming ? (
            <>
              <span className="text-sm text-ink-300">
                Confirm {candidate.team} as your week {week} pick? {candidate.team} will be
                permanently excluded from every later week.
              </span>
              <Button
                variant="success"
                size="sm"
                disabled={busy != null}
                onClick={() => {
                  setConfirming(false);
                  onConfirm(week, candidate.team);
                }}
              >
                {busy?.startsWith("confirm") ? <Spinner /> : null} Yes, confirm
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                Cancel
              </Button>
            </>
          ) : (
            <Button variant="primary" onClick={() => setConfirming(true)} disabled={busy != null}>
              Confirm {candidate.team} as week {week} pick
            </Button>
          )}
          <span className="text-[11px] text-ink-500">
            A recommendation is never treated as used until you confirm it.
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
