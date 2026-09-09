"use client";

import type { ProjectedOwnershipRow, SensitivityReport } from "@/lib/gametheory/types";
import { cn, pct } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../ui";

/** §12 — projected private-pool ownership, clearly labelled as predicted. */
export function OwnershipPanel({
  rows,
  activeOpponents,
  isColdStart,
  note,
}: {
  rows: ProjectedOwnershipRow[];
  activeOpponents: number;
  isColdStart: boolean;
  note: string;
}) {
  const top = rows.filter((r) => r.expectedEntries > 0.005).slice(0, 12);
  const max = Math.max(0.001, ...top.map((r) => r.share));

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Projected pool picks</CardTitle>
        <Badge tone="violet">Model-predicted</Badge>
      </CardHeader>
      <CardContent className="space-y-2">
        {activeOpponents === 0 ? (
          <p className="text-xs text-ink-500">
            No active opposing entries. Add or import them on the{" "}
            <span className="text-accent">Pool state</span> page to enable pool-equity analysis.
          </p>
        ) : (
          <>
            {top.map((r) => (
              <div key={r.team} className="flex items-center gap-2 text-xs">
                <span className="w-9 font-semibold text-ink-200">{r.team}</span>
                <span className="h-2 flex-1 overflow-hidden rounded-full bg-ink-800">
                  <span
                    className="block h-full rounded-full bg-violet"
                    style={{ width: `${(r.share / max) * 100}%` }}
                  />
                </span>
                <span className="tabular w-24 text-right text-ink-300">
                  {r.expectedEntries.toFixed(1)} entries
                </span>
                <span className="tabular w-12 text-right text-ink-400">{pct(r.share, 0)}</span>
                {r.known > 0 ? <Badge tone="good">{r.known} known</Badge> : null}
              </div>
            ))}
            <p className="pt-1 text-[11px] leading-relaxed text-ink-500">
              Expected selections across {activeOpponents} active opposing{" "}
              {activeOpponents === 1 ? "entry" : "entries"} — not known selections. Each entry can
              only be counted for teams it still holds, which is why these differ from national
              survivor ownership. {note}
            </p>
            {isColdStart ? (
              <p className="rounded-lg border border-warn/30 bg-warn/5 p-2 text-[11px] text-warn">
                No pool history has been imported yet, so these predictions come from cold-start
                priors. Import prior weeks on the Pool state page to sharpen them.
              </p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

/** §25 — how the recommendation holds up under other assumptions about the field. */
export function SensitivityPanel({
  sensitivity,
  objective,
}: {
  sensitivity: SensitivityReport | null;
  objective: string;
}) {
  if (!sensitivity) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Opponent-behaviour sensitivity</CardTitle>
        </CardHeader>
        <CardContent className="text-xs text-ink-500">
          Run the tournament with sensitivity enabled to stress-test the recommendation against
          alternative assumptions about how the other entries pick.
        </CardContent>
      </Card>
    );
  }

  const teams = [
    ...new Set(sensitivity.scenarios.flatMap((s) => Object.keys(s.byTeam))),
  ].slice(0, 8);
  const useEquity = objective === "EXPECTED_PRIZE_EQUITY";

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Opponent-behaviour sensitivity</CardTitle>
        <Badge
          tone={
            sensitivity.robustness === "HIGH"
              ? "good"
              : sensitivity.robustness === "MEDIUM"
                ? "warn"
                : "bad"
          }
        >
          {sensitivity.robustness}
        </Badge>
      </CardHeader>
      <CardContent className="px-0">
        <div className="scroll-x px-5">
          <table className="w-full min-w-[460px] text-sm">
            <thead>
              <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                <th className="py-1.5 text-left">Team</th>
                {sensitivity.scenarios.map((s) => (
                  <th key={s.scenario} className="py-1.5 text-right" title={s.description}>
                    {s.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {teams.map((team) => (
                <tr key={team} className="border-b border-ink-850/70">
                  <td
                    className={cn(
                      "py-1.5 font-semibold",
                      team === sensitivity.primaryTeam ? "text-violet" : "text-ink-200",
                    )}
                  >
                    {team}
                  </td>
                  {sensitivity.scenarios.map((s) => {
                    const v = s.byTeam[team];
                    const isBest = s.bestTeam === team;
                    return (
                      <td
                        key={s.scenario}
                        className={cn(
                          "tabular py-1.5 text-right",
                          isBest ? "font-semibold text-good" : "text-ink-300",
                        )}
                      >
                        {v
                          ? pct(useEquity ? v.expectedPrizeEquity : v.poolWinProbability)
                          : "—"}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="px-5 pt-3 text-[11px] leading-relaxed text-ink-500">
          {sensitivity.primaryTeam} is the recommended pick in{" "}
          {sensitivity.scenarios.filter((s) => s.bestTeam === sensitivity.primaryTeam).length}/
          {sensitivity.scenarios.length} scenarios. Each column re-runs the full tournament with a
          different assumption about how the other entries choose — the numbers are simulated, not
          adjusted.
        </p>
      </CardContent>
    </Card>
  );
}

/** §26 — the two genuinely different sources of uncertainty, kept apart. */
export function ConfidencePanel({
  confidence,
}: {
  confidence: {
    football: string;
    opponentModel: string;
    poolEquity: string;
    rationale: string[];
  };
}) {
  const tone = (v: string) =>
    v === "HIGH" ? "good" : v === "MEDIUM" ? "warn" : v === "NONE" ? "neutral" : "bad";
  return (
    <Card>
      <CardHeader>
        <CardTitle>Confidence</CardTitle>
      </CardHeader>
      <CardContent className="space-y-2">
        <div className="flex flex-wrap gap-4 text-xs">
          <span className="flex items-center gap-2">
            <span className="text-ink-400">Football</span>
            <Badge tone={tone(confidence.football)}>{confidence.football}</Badge>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-ink-400">Opponent model</span>
            <Badge tone={tone(confidence.opponentModel)}>{confidence.opponentModel}</Badge>
          </span>
          <span className="flex items-center gap-2">
            <span className="text-ink-400">Pool equity</span>
            <Badge tone={tone(confidence.poolEquity)}>{confidence.poolEquity}</Badge>
          </span>
        </div>
        <ul className="space-y-1 text-[11px] leading-relaxed text-ink-500">
          {confidence.rationale.map((r, i) => (
            <li key={i} className="flex gap-2">
              <span className="text-ink-700">·</span>
              <span>{r}</span>
            </li>
          ))}
        </ul>
        <p className="text-[11px] leading-relaxed text-ink-600">
          A pick can have a stable football probability and still carry uncertain strategic value,
          because what the other entries do is unknown. These are tracked separately on purpose.
        </p>
      </CardContent>
    </Card>
  );
}
