import Link from "next/link";
import { loadModelArtifact } from "@/lib/model/artifact";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

interface Metric {
  n: number;
  brier: number;
  logLoss: number;
  accuracy: number;
}
interface CalRow {
  bin: string;
  n: number;
  predicted: number | null;
  actual: number | null;
}
interface MetricBlock {
  model?: Metric;
  market?: Metric;
  blend?: Metric;
  calibration?: CalRow[];
}

export default async function ModelPage() {
  const artifact = await loadModelArtifact(true);
  const metrics = (artifact.metrics ?? {}) as { inSample?: MetricBlock; holdout?: MetricBlock };
  const holdout = metrics.holdout;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">Team model</h1>
        <Link href="/" className="text-xs text-accent hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      {artifact.isFallback ? (
        <Card className="border-warn/40 bg-warn/5">
          <CardContent className="pt-4 text-sm text-warn">
            <span className="font-semibold">No trained artifact found. </span>
            The app is running on built-in default parameters. Train one with{" "}
            <code className="rounded bg-ink-950 px-1.5 py-0.5 text-xs">npm run train</code>.
          </CardContent>
        </Card>
      ) : null}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="flex items-center justify-between gap-2">
            <CardTitle>Artifact</CardTitle>
            <Badge tone={artifact.isFallback ? "warn" : "good"}>
              {artifact.isFallback ? "untrained default" : `v${artifact.version}`}
            </Badge>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Trained at" value={artifact.trainedAt.slice(0, 19).replace("T", " ")} />
            <Row label="Target season" value={String(artifact.targetSeason)} />
            <Row
              label="Training seasons"
              value={
                artifact.trainSeasons.length
                  ? `${artifact.trainSeasons[0]}–${artifact.trainSeasons[artifact.trainSeasons.length - 1]} (${artifact.trainSeasons.length})`
                  : "—"
              }
            />
            <Row
              label="Hold-out seasons"
              value={artifact.holdoutSeasons.join(", ") || "—"}
            />
            <Row label="Elo k" value={String(artifact.elo.k)} />
            <Row label="Home field (Elo)" value={String(artifact.elo.homeField)} />
            <Row label="Between-season regression" value={`${(artifact.elo.revert * 100).toFixed(0)}%`} />
            <Row label="EPA smoothing α" value={String(artifact.epa.alpha)} />
            <Row
              label="Horizon shrink"
              value={`${(artifact.horizonShrink.perWeek * 100).toFixed(1)}%/week, max ${(artifact.horizonShrink.max * 100).toFixed(0)}%`}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Blend weights (market vs model)</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            <Row label="Base market weight" value={artifact.blend.marketWeightBase.toFixed(2)} />
            <Row label="Per extra sportsbook" value={`+${artifact.blend.marketWeightPerBook.toFixed(3)}`} />
            <Row label="Range" value={`${artifact.blend.marketWeightMin.toFixed(2)} – ${artifact.blend.marketWeightMax.toFixed(2)}`} />
            <Row label="Staleness half-life" value={`${artifact.blend.stalenessHalfLifeHours} h`} />
            <Row label="Single-book penalty" value={`−${(artifact.blend.singleBookPenalty * 100).toFixed(0)}%`} />
            <p className="pt-2 text-[11px] leading-relaxed text-ink-500">
              The current betting market is the single strongest predictor of a current-week game,
              so it receives high weight when it is fresh and deep. A thin or stale market loses
              that privilege and the football model carries more of the estimate. Games with no
              market at all are model-only.
            </p>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Hold-out performance (chronological, no look-ahead)</CardTitle>
        </CardHeader>
        <CardContent>
          {holdout ? (
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                    <th className="py-2 text-left">Source</th>
                    <th className="py-2 text-right">Games</th>
                    <th className="py-2 text-right">Brier</th>
                    <th className="py-2 text-right">Log loss</th>
                    <th className="py-2 text-right">Accuracy</th>
                  </tr>
                </thead>
                <tbody>
                  {(["model", "market", "blend"] as const).map((k) => {
                    const m = holdout[k];
                    if (!m) return null;
                    return (
                      <tr key={k} className="border-b border-ink-850/70">
                        <td className="py-2 capitalize text-ink-200">{k}</td>
                        <td className="tabular py-2 text-right text-ink-400">{m.n}</td>
                        <td className="tabular py-2 text-right text-ink-100">{m.brier.toFixed(4)}</td>
                        <td className="tabular py-2 text-right text-ink-100">{m.logLoss.toFixed(4)}</td>
                        <td className="tabular py-2 text-right text-ink-300">
                          {(m.accuracy * 100).toFixed(1)}%
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              <p className="pt-3 text-[11px] leading-relaxed text-ink-500">
                Lower Brier and log loss are better. The market being hard to beat is the expected
                result and is precisely why it anchors current-week probabilities here.
              </p>
            </div>
          ) : (
            <p className="text-sm text-ink-500">
              No metrics in the artifact. Run <code>npm run train</code>.
            </p>
          )}
        </CardContent>
      </Card>

      {holdout?.calibration ? (
        <Card>
          <CardHeader>
            <CardTitle>Calibration — predicted vs actual (favourite&apos;s side)</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="scroll-x">
              <table className="w-full min-w-[520px] text-sm">
                <thead>
                  <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                    <th className="py-2 text-left">Bin</th>
                    <th className="py-2 text-right">Games</th>
                    <th className="py-2 text-right">Predicted</th>
                    <th className="py-2 text-right">Actual</th>
                    <th className="py-2 text-left">Difference</th>
                  </tr>
                </thead>
                <tbody>
                  {holdout.calibration.map((r) => {
                    const diff =
                      r.predicted != null && r.actual != null ? r.actual - r.predicted : null;
                    return (
                      <tr key={r.bin} className="border-b border-ink-850/70">
                        <td className="py-2 text-ink-200">{r.bin}</td>
                        <td className="tabular py-2 text-right text-ink-400">{r.n}</td>
                        <td className="tabular py-2 text-right text-ink-300">
                          {r.predicted != null ? `${(r.predicted * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="tabular py-2 text-right text-ink-100">
                          {r.actual != null ? `${(r.actual * 100).toFixed(1)}%` : "—"}
                        </td>
                        <td className="py-2">
                          {diff != null ? (
                            <span className="flex items-center gap-2">
                              <span
                                className="h-1.5 rounded-full"
                                style={{
                                  width: `${Math.min(120, Math.abs(diff) * 400)}px`,
                                  background: diff >= 0 ? "var(--color-good)" : "var(--color-bad)",
                                }}
                              />
                              <span className="tabular text-[11px] text-ink-400">
                                {diff >= 0 ? "+" : ""}
                                {(diff * 100).toFixed(1)} pts
                              </span>
                            </span>
                          ) : (
                            <span className="text-ink-600">—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <p className="pt-3 text-[11px] leading-relaxed text-ink-500">
              Calibration matters more here than raw accuracy: the survivor optimiser multiplies
              probability <em>magnitudes</em> together, so a model that says 80% when it means 70%
              produces confidently wrong paths.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader>
          <CardTitle>Retraining and backtesting</CardTitle>
        </CardHeader>
        <CardContent>
          <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs leading-relaxed text-ink-200">
{`npm run train                 # retrain and rewrite data/model/model.json
npm run backtest              # rolling-origin evaluation vs the market
npm run survivor-backtest     # strategy comparison on historical seasons`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-ink-850/70 pb-1.5">
      <span className="text-xs text-ink-400">{label}</span>
      <span className="tabular text-sm text-ink-100">{value}</span>
    </div>
  );
}
