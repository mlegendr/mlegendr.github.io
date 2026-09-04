"use client";

import * as React from "react";
import { Bar, BarChart, Cell, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey } from "@/lib/types";
import { pct } from "@/lib/ui";
import { Button, Card, CardContent, CardHeader, CardTitle, Select, Spinner } from "./ui";

/**
 * Monte Carlo robustness, run on demand.
 *
 * This answers "how often is this actually the right pick if my future estimates
 * are wrong in plausible ways?" — a different question from "how likely is this
 * team to win?", and the label says so.
 */
export function RobustnessPanel({
  snapshot,
  horizon,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
}) {
  const [rows, setRows] = React.useState(snapshot.robustness ?? []);
  const [sims, setSims] = React.useState(2000);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [ranAt, setRanAt] = React.useState<string | null>(snapshot.robustness ? "initial" : null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/robustness", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ simulations: sims, horizon }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Simulation failed");
      setRows(json.robustness ?? []);
      setRanAt(new Date().toLocaleTimeString());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const data = rows.slice(0, 8).map((r) => ({ team: r.team, share: Number((r.share * 100).toFixed(1)) }));

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Recommendation robustness</CardTitle>
        <div className="flex items-center gap-2">
          <Select
            value={String(sims)}
            onChange={(e) => setSims(Number(e.target.value))}
            className="h-7 text-[11px]"
          >
            <option value="1000">1,000 sims</option>
            <option value="2000">2,000 sims</option>
            <option value="5000">5,000 sims</option>
          </Select>
          <Button size="sm" variant="outline" onClick={run} disabled={busy}>
            {busy ? <Spinner /> : null} {busy ? "Simulating…" : "Run"}
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {error ? <p className="text-xs text-bad">{error}</p> : null}
        {data.length === 0 ? (
          <p className="text-[11px] leading-relaxed text-ink-500">
            Perturbs the uncertain parts of the forecast (future weeks far more than a fresh
            current-week market) and re-solves the optimiser each time. Reports the share of
            scenarios in which each team is the correct pick — this is <em>not</em> a win
            probability.
          </p>
        ) : (
          <>
            <div className="h-40 w-full">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={data} layout="vertical" margin={{ left: 4, right: 24, top: 2, bottom: 2 }}>
                  <XAxis type="number" hide domain={[0, 100]} />
                  <YAxis
                    type="category"
                    dataKey="team"
                    width={38}
                    tick={{ fill: "#cbd5e1", fontSize: 11 }}
                    axisLine={false}
                    tickLine={false}
                  />
                  <Tooltip
                    cursor={{ fill: "#1e2739" }}
                    contentStyle={{
                      background: "#111725",
                      border: "1px solid #2a344a",
                      borderRadius: 8,
                      fontSize: 12,
                    }}
                    formatter={(v: number) => [`${v}%`, "optimal in"]}
                  />
                  <Bar dataKey="share" radius={[0, 4, 4, 0]}>
                    {data.map((d, i) => (
                      <Cell key={d.team} fill={i === 0 ? "#62b6ff" : "#2b6ca3"} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <ul className="space-y-1 text-xs">
              {rows.slice(0, 5).map((r) => (
                <li key={r.team} className="flex items-center justify-between">
                  <span className="font-medium text-ink-200">{r.team}</span>
                  <span className="tabular text-ink-400">{pct(r.share, 0)}</span>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-ink-500">
              Share of scenarios in which each team is the optimal week{" "}
              {snapshot.recommendationWeek} pick over the{" "}
              {horizon === "season" ? "rest of season" : `${horizon}-week`} horizon
              {ranAt && ranAt !== "initial" ? ` · run at ${ranAt}` : ""}. Not a win probability.
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}
