"use client";

import type { HeadToHeadAnalysis } from "@/lib/gametheory/poolEquity";
import { pct } from "@/lib/ui";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "../ui";

/**
 * §30 — the small-field endgame. With one opponent left, inventory asymmetry
 * dominates, and this week's joint outcomes are enumerated exactly rather than
 * sampled.
 */
export function HeadToHeadPanel({ data }: { data: HeadToHeadAnalysis }) {
  const grouped = new Map<string, typeof data.jointOutcomes>();
  for (const o of data.jointOutcomes) {
    const list = grouped.get(o.userTeam) ?? [];
    list.push(o);
    grouped.set(o.userTeam, list);
  }

  return (
    <Card className="border-accent/30">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <CardTitle>Head-to-head endgame vs {data.opponentName}</CardTitle>
        <Badge tone="accent">2 entries remaining</Badge>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-3">
          <TeamList
            title="Only you have"
            teams={data.userExclusiveTeams}
            tone="border-good/40 bg-good/10 text-good"
          />
          <TeamList
            title="Both still have"
            teams={data.sharedTeams}
            tone="border-ink-600 bg-ink-800 text-ink-300"
          />
          <TeamList
            title={`Only ${data.opponentName} has`}
            teams={data.opponentExclusiveTeams}
            tone="border-bad/40 bg-bad/10 text-bad"
          />
        </div>

        {grouped.size > 0 ? (
          <div className="scroll-x">
            <table className="w-full min-w-[560px] text-sm">
              <thead>
                <tr className="border-b border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                  <th className="py-1.5 text-left">Your pick</th>
                  <th className="py-1.5 text-left">Their likely pick</th>
                  <th className="py-1.5 text-right">Their P(pick)</th>
                  <th className="py-1.5 text-right">You survive, they don&apos;t</th>
                  <th className="py-1.5 text-right">Both survive</th>
                  <th className="py-1.5 text-right">They survive, you don&apos;t</th>
                  <th className="py-1.5 text-right">Both out</th>
                </tr>
              </thead>
              <tbody>
                {[...grouped.entries()].map(([userTeam, rows]) =>
                  rows.map((o, i) => (
                    <tr key={`${userTeam}-${o.opponentTeam}`} className="border-b border-ink-850/70">
                      <td className="py-1.5 font-semibold text-ink-100">
                        {i === 0 ? userTeam : ""}
                      </td>
                      <td className="py-1.5 text-ink-300">{o.opponentTeam}</td>
                      <td className="tabular py-1.5 text-right text-ink-400">
                        {pct(o.probability, 0)}
                      </td>
                      <td className="tabular py-1.5 text-right text-good">
                        {pct(o.userSurvivesOpponentOut)}
                      </td>
                      <td className="tabular py-1.5 text-right text-ink-300">
                        {pct(o.bothSurvive)}
                      </td>
                      <td className="tabular py-1.5 text-right text-bad">
                        {pct(o.userOutOpponentSurvives)}
                      </td>
                      <td className="tabular py-1.5 text-right text-ink-500">{pct(o.bothOut)}</td>
                    </tr>
                  )),
                )}
              </tbody>
            </table>
          </div>
        ) : null}

        <p className="rounded-lg border border-ink-700 bg-ink-850/50 p-3 text-[11px] leading-relaxed text-ink-400">
          {data.note}
        </p>
      </CardContent>
    </Card>
  );
}

function TeamList({ title, teams, tone }: { title: string; teams: string[]; tone: string }) {
  return (
    <div>
      <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-ink-400">
        {title} ({teams.length})
      </div>
      <div className="flex flex-wrap gap-1">
        {teams.length === 0 ? (
          <span className="text-[11px] text-ink-600">none</span>
        ) : (
          teams.map((t) => (
            <span key={t} className={`rounded border px-1.5 py-0.5 text-[10px] font-semibold ${tone}`}>
              {t}
            </span>
          ))
        )}
      </div>
    </div>
  );
}
