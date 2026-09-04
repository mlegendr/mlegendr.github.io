"use client";

import type { AnalysisSnapshot } from "@/lib/engine";
import { HORIZON_KEYS, type HorizonKey } from "@/lib/types";
import { teamShort } from "@/lib/teams";
import { cn, pct } from "@/lib/ui";
import { Card, CardContent, CardHeader, CardTitle, Hint } from "./ui";

const LABEL: Record<HorizonKey, string> = {
  "3": "3-week",
  "6": "6-week",
  "9": "9-week",
  season: "Rest of season",
};

/**
 * Shows whether the recommendation survives a change of horizon.
 * A pick that wins at 3, 6, 9 and season-long is a far stronger signal than one
 * that only wins at a single horizon.
 */
export function HorizonPanel({
  snapshot,
  horizon,
  onHorizonChange,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
  onHorizonChange: (h: HorizonKey) => void;
}) {
  const winners = HORIZON_KEYS.map((k) => ({
    key: k,
    team: snapshot.bestByHorizon[k]?.team ?? null,
    survival: snapshot.bestByHorizon[k]?.survival ?? 0,
  }));
  const distinct = new Set(winners.map((w) => w.team).filter(Boolean));

  return (
    <Card>
      <CardHeader className="flex items-baseline justify-between gap-2">
        <CardTitle>Optimization horizons</CardTitle>
        <Hint content="Each row re-solves the whole no-repeat assignment over a different number of remaining weeks.">
          <span className="cursor-help text-[11px] text-ink-500">what is this?</span>
        </Hint>
      </CardHeader>
      <CardContent className="space-y-2">
        {winners.map((w) => (
          <button
            key={w.key}
            onClick={() => onHorizonChange(w.key)}
            className={cn(
              "flex w-full items-center justify-between rounded-lg border px-3 py-2 text-left transition-colors",
              horizon === w.key
                ? "border-accent/50 bg-accent/10"
                : "border-ink-700 bg-ink-850/50 hover:border-ink-600",
            )}
          >
            <span className="text-xs font-medium text-ink-300">{LABEL[w.key]} best</span>
            <span className="flex items-center gap-3">
              <span className="text-sm font-semibold text-ink-100">
                {w.team ? teamShort(w.team) : "—"}
              </span>
              <span className="tabular w-16 text-right text-xs text-ink-400">
                {pct(w.survival, w.key === "season" ? 2 : 1)}
              </span>
            </span>
          </button>
        ))}

        <p
          className={cn(
            "rounded-lg border p-2.5 text-[11px] leading-relaxed",
            distinct.size === 1
              ? "border-good/30 bg-good/5 text-good"
              : "border-warn/30 bg-warn/5 text-warn",
          )}
        >
          {distinct.size === 1
            ? `Every horizon agrees on ${teamShort([...distinct][0] as string)}. That is the strongest form of robustness this app can report.`
            : `The optimal pick changes with the horizon (${[...distinct]
                .map((t) => teamShort(t as string))
                .join(" / ")}). Far-future probabilities carry real uncertainty — prefer the medium horizon unless you have a reason not to.`}
        </p>
      </CardContent>
    </Card>
  );
}
