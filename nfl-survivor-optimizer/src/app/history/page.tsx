import Link from "next/link";
import { prisma } from "@/lib/db";
import { env } from "@/lib/env";
import { getOrCreatePool, listPicks } from "@/lib/pool";
import { teamName } from "@/lib/teams";
import { Badge, Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function HistoryPage() {
  const pool = await getOrCreatePool(env.season);
  const picks = await listPicks(pool.id, pool.season);
  const games = await prisma.game.findMany({
    where: { id: { in: picks.map((p) => p.gameId ?? "").filter(Boolean) } },
  });
  const gameById = new Map(games.map((g) => [g.id, g]));

  const confirmed = picks.filter((p) => p.confirmed);
  const wins = confirmed.filter((p) => p.result === "WIN").length;
  const losses = confirmed.filter((p) => p.result === "LOSS").length;
  const pending = confirmed.filter((p) => p.result === "PENDING").length;
  const alive = losses === 0;

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <h1 className="text-lg font-semibold tracking-tight text-ink-100">
          Pick history — {pool.season}
        </h1>
        <Link href="/" className="text-xs text-accent hover:underline">
          ← Back to dashboard
        </Link>
      </div>

      <div className="grid gap-4 md:grid-cols-4">
        <SummaryCard label="Confirmed picks" value={String(confirmed.length)} />
        <SummaryCard label="Wins" value={String(wins)} tone="good" />
        <SummaryCard label="Losses" value={String(losses)} tone={losses ? "bad" : "neutral"} />
        <SummaryCard
          label="Status"
          value={alive ? (pending ? "Alive (pending)" : "Alive") : "Eliminated"}
          tone={alive ? "good" : "bad"}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Every recorded selection</CardTitle>
        </CardHeader>
        <CardContent className="px-0">
          {picks.length === 0 ? (
            <p className="px-5 text-sm text-ink-500">
              Nothing recorded yet. Confirm a pick from the dashboard and it will be written to the
              local SQLite database — it survives browser and server restarts.
            </p>
          ) : (
            <div className="scroll-x">
              <table className="w-full min-w-[720px] text-sm">
                <thead>
                  <tr className="border-y border-ink-800 text-[10px] uppercase tracking-wider text-ink-500">
                    <th className="px-5 py-2 text-left">Week</th>
                    <th className="px-3 py-2 text-left">Team</th>
                    <th className="px-3 py-2 text-left">Opponent</th>
                    <th className="px-3 py-2 text-left">Score</th>
                    <th className="px-3 py-2 text-left">Confirmed</th>
                    <th className="px-3 py-2 text-right">Result</th>
                  </tr>
                </thead>
                <tbody>
                  {picks.map((p) => {
                    const g = p.gameId ? gameById.get(p.gameId) : null;
                    const score =
                      g && g.completed && g.homeScore != null && g.awayScore != null
                        ? `${g.awayTeamAbbr} ${g.awayScore} — ${g.homeScore} ${g.homeTeamAbbr}`
                        : "—";
                    return (
                      <tr key={p.id} className="border-b border-ink-850/70">
                        <td className="tabular px-5 py-2 text-ink-400">Week {p.week}</td>
                        <td className="px-3 py-2 font-semibold text-ink-100">
                          {teamName(p.team)}
                        </td>
                        <td className="px-3 py-2 text-ink-400">
                          {p.opponent ? teamName(p.opponent) : "—"}
                        </td>
                        <td className="tabular px-3 py-2 text-xs text-ink-400">{score}</td>
                        <td className="px-3 py-2">
                          {p.confirmed ? (
                            <Badge tone="accent">Confirmed</Badge>
                          ) : (
                            <Badge tone="neutral">Provisional</Badge>
                          )}
                        </td>
                        <td className="px-3 py-2 text-right">
                          <Badge
                            tone={
                              p.result === "WIN"
                                ? "good"
                                : p.result === "LOSS"
                                  ? "bad"
                                  : p.result === "TIE"
                                    ? "warn"
                                    : "neutral"
                            }
                          >
                            {p.result}
                          </Badge>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Backup</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2 text-sm text-ink-300">
          <p>
            Export and import live on the dashboard&apos;s Pick History panel, or straight from the
            API:
          </p>
          <pre className="overflow-x-auto rounded-lg border border-ink-700 bg-ink-950 p-3 text-xs text-ink-200">
{`curl http://localhost:3000/api/pool/export > survivor-backup.json
curl -X POST http://localhost:3000/api/pool/import \\
  -H 'content-type: application/json' \\
  --data @survivor-backup.json`}
          </pre>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({
  label,
  value,
  tone,
}: {
  label: string;
  value: string;
  tone?: "good" | "bad" | "neutral";
}) {
  return (
    <Card>
      <CardContent className="pt-4">
        <div className="text-[10px] font-semibold uppercase tracking-[0.12em] text-ink-400">
          {label}
        </div>
        <div
          className={
            "tabular mt-1 text-2xl font-semibold " +
            (tone === "good" ? "text-good" : tone === "bad" ? "text-bad" : "text-ink-100")
          }
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}
