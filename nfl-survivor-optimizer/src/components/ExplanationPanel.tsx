"use client";

import type { AnalysisSnapshot } from "@/lib/engine";
import type { HorizonKey, ProbabilityFactor } from "@/lib/types";
import { teamName } from "@/lib/teams";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "./ui";

const KIND_TONE: Record<ProbabilityFactor["kind"], "accent" | "violet" | "warn"> = {
  fact: "accent",
  estimate: "violet",
  assumption: "warn",
};

const KIND_LABEL: Record<ProbabilityFactor["kind"], string> = {
  fact: "Fact",
  estimate: "Model estimate",
  assumption: "Assumption",
};

function FactorList({ items }: { items: ProbabilityFactor[] }) {
  return (
    <ul className="space-y-2">
      {items.map((f, i) => (
        <li key={i} className="flex gap-2.5 text-sm leading-relaxed">
          <Badge tone={KIND_TONE[f.kind]} className="mt-0.5 shrink-0">
            {KIND_LABEL[f.kind]}
          </Badge>
          <span className="text-ink-200">
            <span className="font-medium text-ink-100">{f.label}. </span>
            {f.detail}
          </span>
        </li>
      ))}
    </ul>
  );
}

export function ExplanationPanel({
  snapshot,
  horizon,
}: {
  snapshot: AnalysisSnapshot;
  horizon: HorizonKey;
}) {
  const e = snapshot.explanation;
  if (!e) return null;
  const best = snapshot.candidates[0];

  return (
    <Card>
      <CardHeader className="flex items-baseline justify-between gap-3">
        <CardTitle>Why {teamName(best.team)}?</CardTitle>
        <span className="text-[11px] text-ink-500">{e.headline}</span>
      </CardHeader>
      <CardContent className="space-y-5">
        <FactorList items={e.why} />

        {e.whyNot ? (
          <div className="rounded-lg border border-ink-700 bg-ink-850/60 p-4">
            <div className="mb-2 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-300">
              Why not {teamName(e.whyNot.team)}?
            </div>
            <FactorList items={e.whyNot.lines} />
          </div>
        ) : null}

        {e.comparison ? (
          <p className="rounded-lg border border-accent/25 bg-accent/5 p-3 text-sm leading-relaxed text-ink-200">
            {e.comparison}
          </p>
        ) : null}

        <div>
          <div className="mb-1.5 text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-400">
            What this does not know
          </div>
          <ul className="space-y-1 text-xs leading-relaxed text-ink-400">
            {e.caveats.map((c, i) => (
              <li key={i} className="flex gap-2">
                <span className="text-ink-600">·</span>
                <span>{c}</span>
              </li>
            ))}
          </ul>
        </div>
        <div className="text-[11px] text-ink-500">
          Horizon in use: {horizon === "season" ? "rest of season" : `${horizon} weeks`}.
        </div>
      </CardContent>
    </Card>
  );
}
