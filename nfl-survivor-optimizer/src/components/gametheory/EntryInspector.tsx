"use client";

import * as React from "react";
import type { EntryBehaviorSummary } from "@/lib/gametheory/context";
import type { EntryPickDistribution, EntryState } from "@/lib/gametheory/types";
import { TEAM_ABBRS, teamName } from "@/lib/teams";
import { cn, pct } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Select, Spinner } from "../ui";

/**
 * §27 — inspect one entry: its exact remaining inventory, its observed
 * decisions described statistically, and its predicted pick for this week.
 */
export function EntryInspector({
  state,
  behavior,
  distribution,
  currentWeek,
  onKnownPick,
  busy,
}: {
  state: EntryState | null;
  behavior: EntryBehaviorSummary | null;
  distribution: EntryPickDistribution | null;
  currentWeek: number;
  onKnownPick: (entryId: string, team: string | null) => void;
  busy: boolean;
}) {
  const [known, setKnown] = React.useState("");

  React.useEffect(() => {
    setKnown(state?.knownCurrentPick ?? "");
  }, [state?.entry.id, state?.knownCurrentPick]);

  if (!state) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Entry inspector</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-500">
          Select an entry from the pool-state table to see exactly which teams it can still use.
        </CardContent>
      </Card>
    );
  }

  const used = new Set(state.usedTeams);
  const predicted = Object.entries(distribution?.distribution ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6);

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-baseline justify-between gap-2">
        <CardTitle>{state.entry.displayName}</CardTitle>
        <span className="flex items-center gap-2 text-[11px] text-ink-500">
          {state.entry.ownerName ? <span>Owner: {state.entry.ownerName}</span> : null}
          <Badge
            tone={
              state.entry.status === "ACTIVE"
                ? "good"
                : state.entry.status === "ELIMINATED"
                  ? "bad"
                  : "warn"
            }
          >
            {state.entry.status}
          </Badge>
        </span>
      </CardHeader>
      <CardContent className="space-y-4">
        {state.entry.eliminationReason ? (
          <p className="rounded-lg border border-bad/30 bg-bad/5 p-2.5 text-[11px] text-bad">
            {state.entry.eliminationReason}
          </p>
        ) : null}

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Past picks
          </div>
          {state.picks.length === 0 ? (
            <p className="text-xs text-ink-600">No picks recorded.</p>
          ) : (
            <ul className="space-y-1 text-xs">
              {[...state.picks]
                .sort((a, b) => a.week - b.week)
                .map((p) => {
                  const decision = behavior?.decisions.find((d) => d.week === p.week);
                  return (
                    <li key={p.id} className="flex flex-wrap items-baseline gap-2">
                      <span className="tabular w-8 text-ink-500">W{p.week}</span>
                      <span className="font-semibold text-ink-100">{p.team}</span>
                      <Badge
                        tone={
                          p.pickStatus === "WIN"
                            ? "good"
                            : p.pickStatus === "LOSS"
                              ? "bad"
                              : p.pickStatus === "TIE"
                                ? "warn"
                                : "neutral"
                        }
                      >
                        {p.pickStatus}
                      </Badge>
                      {decision ? (
                        <span className="text-ink-500">
                          weekly safety rank #{decision.safetyRankPosition} of {decision.optionCount}
                        </span>
                      ) : null}
                    </li>
                  );
                })}
            </ul>
          )}
        </div>

        {behavior ? (
          <div className="rounded-lg border border-ink-700 bg-ink-850/50 p-3">
            <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
              Observed tendency
            </div>
            <p className="text-xs leading-relaxed text-ink-200">{behavior.observedTendency}</p>
            <p className="mt-1.5 text-[11px] leading-relaxed text-ink-500">
              Entry-specific confidence: <span className="font-semibold">{behavior.confidence}</span>{" "}
              — {behavior.decisions.length} decision{behavior.decisions.length === 1 ? "" : "s"}{" "}
              observed. The forecast applies {pct(behavior.shrinkageWeight, 0)} of this entry&apos;s own
              estimate and {pct(1 - behavior.shrinkageWeight, 0)} of pool-average behaviour.
            </p>
          </div>
        ) : null}

        <div>
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">
              Week {currentWeek} selection
            </span>
            <Badge tone={distribution?.isKnown ? "good" : "violet"}>
              {distribution?.isKnown ? "KNOWN" : "MODEL-PREDICTED"}
            </Badge>
          </div>
          {predicted.length === 0 ? (
            <p className="text-xs text-ink-600">No legal options modelled for this week.</p>
          ) : (
            <ul className="space-y-1">
              {predicted.map(([team, p]) => (
                <li key={team} className="flex items-center gap-2 text-xs">
                  <span className="w-9 font-semibold text-ink-200">{team}</span>
                  <span className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink-800">
                    <span
                      className="block h-full rounded-full bg-accent"
                      style={{ width: `${Math.min(100, p * 100)}%` }}
                    />
                  </span>
                  <span className="tabular w-12 text-right text-ink-400">{pct(p, 0)}</span>
                </li>
              ))}
            </ul>
          )}

          <div className="mt-2 flex items-center gap-2">
            <Select
              value={known}
              onChange={(e) => setKnown(e.target.value)}
              className="h-8 flex-1 text-xs"
            >
              <option value="">Record a known pick…</option>
              {state.remainingTeams.map((t) => (
                <option key={t} value={t}>
                  {teamName(t)}
                </option>
              ))}
            </Select>
            <Button
              size="sm"
              variant="outline"
              disabled={busy || !known}
              onClick={() => onKnownPick(state.entry.id, known)}
            >
              {busy ? <Spinner /> : null} Set
            </Button>
            {state.knownCurrentPick ? (
              <Button
                size="sm"
                variant="ghost"
                disabled={busy}
                onClick={() => onKnownPick(state.entry.id, null)}
              >
                Clear
              </Button>
            ) : null}
          </div>
          <p className="mt-1 text-[10px] text-ink-600">
            A known pick replaces this entry&apos;s predicted distribution with certainty and
            immediately changes projected ownership and every candidate&apos;s equity.
          </p>
        </div>

        <div>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
            Inventory — {state.remainingTeams.length} of {TEAM_ABBRS.length} teams still available
          </div>
          <div className="flex flex-wrap gap-1">
            {TEAM_ABBRS.map((t) => (
              <span
                key={t}
                className={cn(
                  "rounded border px-1.5 py-0.5 text-[10px] font-semibold",
                  used.has(t)
                    ? "border-ink-700 bg-ink-800 text-ink-600 line-through"
                    : "border-good/40 bg-good/10 text-good",
                )}
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
