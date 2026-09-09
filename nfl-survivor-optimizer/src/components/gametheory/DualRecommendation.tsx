"use client";

import type { CandidateEvaluation } from "@/lib/types";
import type { PoolEquityExplanation } from "@/lib/gametheory/explain";
import type {
  CandidateTournamentResult,
  PoolObjective,
  ProjectedOwnershipRow,
  SensitivityReport,
} from "@/lib/gametheory/types";
import { OBJECTIVE_LABEL } from "@/lib/gametheory/types";
import { teamName } from "@/lib/teams";
import { cn, pct } from "@/lib/ui";
import { Badge, Card, CardContent, Hint } from "../ui";

/**
 * §21/§41 — the two recommendations side by side, never blended.
 *
 * The left column answers "what would I pick if I ignored every other entry?".
 * The right answers "what maximises my chance of winning THIS pool?". The
 * immediate survival cost of the pool-equity pick is always shown; it is never
 * hidden behind an aggregate score.
 */
export function DualRecommendation({
  survival,
  survivalTournament,
  poolPick,
  objective,
  explanation,
  ownership,
  sensitivity,
  activeOpponents,
  horizonLabel,
}: {
  survival: CandidateEvaluation | null;
  survivalTournament: CandidateTournamentResult | null;
  poolPick: CandidateTournamentResult | null;
  objective: PoolObjective;
  explanation: PoolEquityExplanation | null;
  ownership: ProjectedOwnershipRow[];
  sensitivity: SensitivityReport | null;
  activeOpponents: number;
  horizonLabel: string;
}) {
  const ownOf = (team: string | undefined) =>
    team ? (ownership.find((o) => o.team === team)?.share ?? 0) : 0;
  const agree = !!survival && !!poolPick && survival.team === poolPick.team;

  return (
    <Card className="overflow-hidden">
      <div className="grid gap-px bg-ink-800 md:grid-cols-2">
        {/* -------------------------------------------------- survival --- */}
        <div className="bg-ink-900 p-5">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-ink-300">
              Survival pick
            </span>
            <Hint content="The existing optimizer. Ignores every other entry and maximises your own probability of staying alive.">
              <span className="cursor-help text-[10px] text-ink-600">what is this?</span>
            </Hint>
          </div>
          {survival ? (
            <>
              <div className="mt-2 text-2xl font-semibold text-ink-100">
                {teamName(survival.team)}
              </div>
              <div className="text-sm text-ink-400">
                {survival.isHome ? "vs" : "at"} {teamName(survival.opponent)}
              </div>
              <dl className="mt-4 space-y-1.5 text-sm">
                <Row label="Win probability" value={pct(survival.currentWinProb)} strong />
                <Row label={`${horizonLabel} path survival`} value={pct(survival.pathSurvival[horizonLabel === "Season" ? "season" : horizonLabel.replace("-week", "")])} />
                <Row label="Season path survival" value={pct(survival.pathSurvival["season"], 2)} />
                <Row label="Projected pool ownership" value={pct(ownOf(survival.team), 0)} />
                {survivalTournament ? (
                  <>
                    <Row label="Pool win probability" value={pct(survivalTournament.poolWinProbability)} />
                    <Row label="Expected prize equity" value={pct(survivalTournament.expectedPrizeEquity)} />
                  </>
                ) : null}
              </dl>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
                Safest available path independent of what the other pool entries do.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-500">No eligible team this week.</p>
          )}
        </div>

        {/* ------------------------------------------------ pool equity --- */}
        <div className={cn("p-5", agree ? "bg-ink-900" : "bg-violet/[0.06]")}>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-violet">
              Pool-equity pick
            </span>
            {agree ? (
              <Badge tone="good">agrees</Badge>
            ) : (
              <Badge tone="violet">differs</Badge>
            )}
          </div>
          {poolPick ? (
            <>
              <div className="mt-2 text-2xl font-semibold text-ink-100">
                {teamName(poolPick.team)}
              </div>
              <div className="text-sm text-ink-400">
                {poolPick.isHome ? "vs" : "at"} {teamName(poolPick.opponent)}
              </div>
              <dl className="mt-4 space-y-1.5 text-sm">
                <Row label="Win probability" value={pct(poolPick.currentWinProbability)} />
                <Row label="Survives this week" value={pct(poolPick.survivesCurrentWeek)} />
                <Row label="Projected pool ownership" value={pct(ownOf(poolPick.team), 0)} />
                <Row
                  label="Pool win probability"
                  value={pct(poolPick.poolWinProbability)}
                  strong={objective !== "EXPECTED_PRIZE_EQUITY"}
                />
                <Row
                  label="Expected prize equity"
                  value={pct(poolPick.expectedPrizeEquity)}
                  strong={objective === "EXPECTED_PRIZE_EQUITY"}
                />
                <Row label="Probability of sole victory" value={pct(poolPick.soleVictoryProbability)} />
              </dl>
              <p className="mt-3 text-[11px] leading-relaxed text-ink-500">
                Optimising <span className="text-violet">{OBJECTIVE_LABEL[objective]}</span> across{" "}
                {poolPick.simulations.toLocaleString()} tournament simulations of{" "}
                {activeOpponents} active opposing {activeOpponents === 1 ? "entry" : "entries"}.
              </p>
            </>
          ) : (
            <p className="mt-3 text-sm text-ink-500">Run the tournament to produce this pick.</p>
          )}
        </div>
      </div>

      {/* ------------------------------------------------- the tradeoff --- */}
      {explanation?.tradeoff ? (
        <CardContent className="border-t border-ink-800 pt-4">
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="rounded-lg border border-bad/30 bg-bad/5 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-bad">
                Immediate cost
              </div>
              <div className="tabular mt-1 text-lg font-semibold text-bad">
                {explanation.tradeoff.immediateCostPoints >= 0 ? "+" : ""}
                {explanation.tradeoff.immediateCostPoints.toFixed(1)} pts
              </div>
              <div className="text-[11px] text-ink-400">current-week win probability</div>
            </div>
            <div className="rounded-lg border border-good/30 bg-good/5 p-3">
              <div className="text-[10px] font-semibold uppercase tracking-wider text-good">
                Pool-equity advantage
              </div>
              <div className="tabular mt-1 text-lg font-semibold text-good">
                {explanation.tradeoff.prizeEquityGainPoints >= 0 ? "+" : ""}
                {explanation.tradeoff.prizeEquityGainPoints.toFixed(1)} pts
              </div>
              <div className="text-[11px] text-ink-400">
                expected prize equity ({explanation.tradeoff.poolWinGainPoints >= 0 ? "+" : ""}
                {explanation.tradeoff.poolWinGainPoints.toFixed(1)} pts pool-win probability)
              </div>
            </div>
          </div>
        </CardContent>
      ) : null}

      {explanation ? (
        <CardContent className="border-t border-ink-800 pt-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">
            {agree ? "Why they agree" : "Why the pool-equity model differs"}
          </div>
          <ul className="space-y-1.5 text-sm leading-relaxed text-ink-200">
            {explanation.lines.map((l, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-ink-600">·</span>
                <span>{l}</span>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-[11px] text-ink-500">{explanation.robustnessNote}</p>
          {sensitivity ? (
            <p className="mt-1 text-[11px] text-ink-500">
              Recommendation robustness:{" "}
              <span
                className={cn(
                  "font-semibold",
                  sensitivity.robustness === "HIGH"
                    ? "text-good"
                    : sensitivity.robustness === "MEDIUM"
                      ? "text-warn"
                      : "text-bad",
                )}
              >
                {sensitivity.robustness}
              </span>
            </p>
          ) : null}
        </CardContent>
      ) : null}

      {explanation?.comparison ? (
        <CardContent className="border-t border-ink-800 pt-4">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">
            Direct comparison
          </div>
          <div className="scroll-x">
            <table className="w-full min-w-[380px] text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="py-1.5 text-left" />
                  <th className="py-1.5 text-right">Survival</th>
                  <th className="py-1.5 text-right">Pool equity</th>
                </tr>
              </thead>
              <tbody>
                {explanation.comparison.map((row) => (
                  <tr key={row.label} className="border-b border-ink-850/70">
                    <td className="py-1.5 text-ink-400">{row.label}</td>
                    <td
                      className={cn(
                        "tabular py-1.5 text-right",
                        row.highlight === "survival" ? "font-semibold text-ink-100" : "text-ink-300",
                      )}
                    >
                      {row.survival}
                    </td>
                    <td
                      className={cn(
                        "tabular py-1.5 text-right",
                        row.highlight === "poolEquity" ? "font-semibold text-violet" : "text-ink-300",
                      )}
                    >
                      {row.poolEquity}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </CardContent>
      ) : null}
    </Card>
  );
}

function Row({ label, value, strong }: { label: string; value: string; strong?: boolean }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-xs text-ink-400">{label}</dt>
      <dd
        className={cn(
          "tabular text-sm",
          strong ? "font-semibold text-accent" : "text-ink-100",
        )}
      >
        {value}
      </dd>
    </div>
  );
}
