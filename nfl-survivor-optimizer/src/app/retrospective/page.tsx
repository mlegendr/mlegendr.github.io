import Link from "next/link";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildRetrospective } from "@/lib/gametheory/snapshot";
import { cn } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

/**
 * §36/§37 — predicted vs actual field picks, graded from the frozen pre-lock
 * snapshots. This is how the opponent model earns (or loses) trust over time.
 */
export default async function RetrospectivePage() {
  const pool = await getOrCreatePool(env.season);
  const weeks = await buildRetrospective(pool.id, env.season);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Retrospective — {env.season}
        </h1>
        <Link href="/" className="text-xs text-accent hover:underline">
          ← Dashboard
        </Link>
      </div>

      {weeks.length === 0 ? (
        <Card>
          <CardHeader>
            <CardTitle>No snapshots yet</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm text-ink-300">
            <p>
              Before each week locks, run the pool-equity tournament on the dashboard with{" "}
              <span className="text-ink-100">Snapshot</span> enabled. That freezes the decision
              inputs — odds timestamps, inventories, predicted ownership, every candidate&apos;s
              Pool Win Probability and Expected Prize Equity — so this page can grade the forecast
              once the real picks are known.
            </p>
            <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs text-ink-200">
{`curl -X POST http://localhost:3000/api/pool-equity/snapshot \\
  -H 'content-type: application/json' -d '{"simulations":20000}'`}
            </pre>
          </CardContent>
        </Card>
      ) : null}

      {weeks.map((w) => (
        <Card key={w.week}>
          <CardHeader className="flex flex-wrap items-center justify-between gap-2">
            <CardTitle>Week {w.week}</CardTitle>
            <span className="flex flex-wrap items-center gap-2 text-[11px] text-ink-500">
              {w.opponentLogLoss != null ? (
                <Badge tone={w.opponentLogLoss < 1.6 ? "good" : w.opponentLogLoss < 2.6 ? "warn" : "bad"}>
                  opponent log loss {w.opponentLogLoss.toFixed(3)}
                </Badge>
              ) : null}
              <span>{w.observedPicks} observed opposing picks</span>
            </span>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-4">
              <Field label="You picked" value={w.userPick ?? "—"} tone="accent" />
              <Field label="Naive model" value={w.naivePick ?? "—"} />
              <Field label="Pool-equity model" value={w.poolEquityPick ?? "—"} tone="violet" />
              <Field
                label="Predicted prize equity"
                value={
                  w.predictedPrizeEquity != null
                    ? `${(w.predictedPrizeEquity * 100).toFixed(1)}%`
                    : "—"
                }
              />
            </div>

            {w.comparison.length > 0 ? (
              <div className="scroll-x">
                <table className="w-full min-w-[520px] text-sm">
                  <thead>
                    <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                      <th className="py-1.5 text-left">Team</th>
                      <th className="py-1.5 text-right">Predicted %</th>
                      <th className="py-1.5 text-right">Actual %</th>
                      <th className="py-1.5 text-right">Predicted entries</th>
                      <th className="py-1.5 text-right">Actual entries</th>
                      <th className="py-1.5 text-right">Error</th>
                    </tr>
                  </thead>
                  <tbody>
                    {w.comparison.map((r) => (
                      <tr key={r.team} className="border-b border-ink-850/70">
                        <td className="py-1.5 font-semibold text-ink-100">{r.team}</td>
                        <td className="tabular py-1.5 text-right text-violet">
                          {(r.predictedShare * 100).toFixed(0)}%
                        </td>
                        <td className="tabular py-1.5 text-right text-ink-100">
                          {(r.actualShare * 100).toFixed(0)}%
                        </td>
                        <td className="tabular py-1.5 text-right text-ink-400">
                          {r.predictedEntries.toFixed(1)}
                        </td>
                        <td className="tabular py-1.5 text-right text-ink-300">{r.actualEntries}</td>
                        <td
                          className={cn(
                            "tabular py-1.5 text-right",
                            Math.abs(r.errorPoints) > 20
                              ? "text-bad"
                              : Math.abs(r.errorPoints) > 10
                                ? "text-warn"
                                : "text-ink-400",
                          )}
                        >
                          {r.errorPoints >= 0 ? "+" : ""}
                          {r.errorPoints.toFixed(0)} pts
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            <p className="text-[11px] leading-relaxed text-ink-500">{w.note}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Field({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "accent" | "violet";
}) {
  return (
    <div>
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-400">{label}</div>
      <div
        className={cn(
          "mt-0.5 text-lg font-semibold",
          tone === "accent" ? "text-accent" : tone === "violet" ? "text-violet" : "text-ink-100",
        )}
      >
        {value}
      </div>
    </div>
  );
}
