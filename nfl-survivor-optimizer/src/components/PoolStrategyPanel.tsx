"use client";

import * as React from "react";
import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey } from "@/lib/types";
import type { PoolStrategyResult } from "@/lib/pool-strategy";
import { pct } from "@/lib/ui";
import { Badge, Button, Card, CardContent, CardHeader, CardTitle, Input, Label, Spinner, Switch } from "./ui";

/**
 * OPTIONAL leverage mode. Off by default, and it refuses to run on invented data:
 * pick-popularity numbers must come from the user.
 */
export function PoolStrategyPanel({
  snapshot,
  horizon,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
}) {
  const [enabled, setEnabled] = React.useState(snapshot.settings.poolStrategyEnabled);
  const [entries, setEntries] = React.useState(String(snapshot.settings.remainingEntries ?? ""));
  const [risk, setRisk] = React.useState(snapshot.settings.riskPreference);
  const [popularity, setPopularity] = React.useState<Record<string, string>>(() =>
    Object.fromEntries(
      Object.entries(snapshot.settings.pickPopularity ?? {}).map(([k, v]) => [k, String(v)]),
    ),
  );
  const [result, setResult] = React.useState<PoolStrategyResult | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const topTeams = snapshot.candidates.slice(0, 8).map((c) => c.team);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const pop: Record<string, number> = {};
      for (const [k, v] of Object.entries(popularity)) {
        const n = Number(v);
        if (v !== "" && Number.isFinite(n)) pop[k] = n / 100;
      }
      const res = await fetch("/api/pool-strategy", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          remainingEntries: Number(entries) || 0,
          pickPopularity: pop,
          riskPreference: risk,
          horizon,
          persist: true,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? "Pool strategy failed");
      setResult(json as PoolStrategyResult);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Pool strategy (optional)</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-ink-400">
            {enabled ? "Leverage mode" : "Maximize survival"}
          </span>
          <Switch checked={enabled} onCheckedChange={setEnabled} />
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-[11px] leading-relaxed text-ink-500">
          Maximising survival is not the same as maximising your chance of{" "}
          <em>winning a large pool</em>. If most of the field is on your team, surviving with them
          buys little. This mode needs your own numbers: the app will not invent public pick
          popularity.
        </p>

        {!enabled ? (
          <p className="text-xs text-ink-400">
            Default mode is <span className="font-semibold text-ink-200">Maximize Survival</span>.
            Toggle above to configure leverage.
          </p>
        ) : (
          <>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label htmlFor="entries">Remaining entries</Label>
                <Input
                  id="entries"
                  value={entries}
                  onChange={(e) => setEntries(e.target.value)}
                  placeholder="e.g. 480"
                  inputMode="numeric"
                  className="mt-1"
                />
              </div>
              <div>
                <Label htmlFor="risk">Risk preference ({risk.toFixed(2)})</Label>
                <input
                  id="risk"
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={risk}
                  onChange={(e) => setRisk(Number(e.target.value))}
                  className="mt-3 w-full accent-[color:var(--color-accent)]"
                />
              </div>
            </div>

            <div>
              <Label>Estimated pick popularity (% of the field)</Label>
              <div className="mt-1.5 grid grid-cols-2 gap-2 sm:grid-cols-4">
                {topTeams.map((t) => (
                  <div key={t} className="flex items-center gap-1.5">
                    <span className="w-9 text-xs font-semibold text-ink-300">{t}</span>
                    <Input
                      value={popularity[t] ?? ""}
                      onChange={(e) =>
                        setPopularity((p) => ({ ...p, [t]: e.target.value }))
                      }
                      placeholder="%"
                      inputMode="decimal"
                      className="h-8 text-xs"
                    />
                  </div>
                ))}
              </div>
              <p className="mt-1.5 text-[10px] text-ink-600">
                Manual estimates only — clearly labelled as such wherever they are used.
              </p>
            </div>

            <Button size="sm" variant="outline" onClick={run} disabled={busy}>
              {busy ? <Spinner /> : null} Evaluate leverage
            </Button>

            {error ? <p className="text-xs text-bad">{error}</p> : null}

            {result ? (
              result.usable ? (
                <div className="space-y-2">
                  <p className="rounded-lg border border-violet/30 bg-violet/5 p-2.5 text-[11px] leading-relaxed text-violet">
                    {result.message}
                  </p>
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                        <th className="py-1 text-left">Team</th>
                        <th className="py-1 text-right">Path survival</th>
                        <th className="py-1 text-right">Popularity</th>
                        <th className="py-1 text-right">Equity</th>
                        <th className="py-1 text-right">Leverage</th>
                      </tr>
                    </thead>
                    <tbody>
                      {result.rows.slice(0, 8).map((r) => (
                        <tr key={r.team} className="border-b border-ink-850/70">
                          <td className="py-1.5 font-semibold text-ink-100">{r.team}</td>
                          <td className="tabular py-1.5 text-right text-ink-300">
                            {pct(r.survival)}
                          </td>
                          <td className="tabular py-1.5 text-right text-ink-400">
                            {pct(r.popularity, 0)}
                          </td>
                          <td className="tabular py-1.5 text-right text-ink-300">
                            {(r.equity * 1000).toFixed(2)}‰
                          </td>
                          <td className="py-1.5 text-right">
                            <Badge
                              tone={
                                r.leverage === "CONTRARIAN"
                                  ? "violet"
                                  : r.leverage === "CHALK"
                                    ? "neutral"
                                    : "accent"
                              }
                            >
                              {r.leverage}
                            </Badge>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              ) : (
                <p className="rounded-lg border border-warn/30 bg-warn/5 p-2.5 text-[11px] leading-relaxed text-warn">
                  {result.message}
                </p>
              )
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}
