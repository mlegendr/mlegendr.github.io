import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildAnalysis } from "@/lib/engine";
import { loadCanonicalGames } from "@/lib/refresh";
import { regularSeasonWeeks } from "@/lib/schedule-utils";
import {
  ensureUserEntry,
  gradeEntries,
  loadEntryStates,
  syncUserEntryFromPicks,
} from "@/lib/gametheory/entries";
import { computeInventoryEdges } from "@/lib/gametheory/inventory";
import { PoolStateView } from "@/components/gametheory/PoolStateView";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function PoolPage() {
  const season = env.season;
  let week = 1;
  try {
    week = (await buildAnalysis({ season, includeRobustness: false })).recommendationWeek;
  } catch {
    week = 1;
  }

  const pool = await getOrCreatePool(season);
  await ensureUserEntry(pool.id, season);
  await syncUserEntryFromPicks(pool.id, season);
  await gradeEntries(pool.id, season, pool.settings.tieCountsAsLoss);

  const entries = await loadEntryStates(pool.id, season, week);
  const games = await loadCanonicalGames(season);
  const weeks = regularSeasonWeeks(games).filter((w) => w <= pool.settings.totalRegularSeasonWeeks);

  if (games.length === 0) {
    return (
      <Card className="mx-auto mt-10 max-w-2xl border-bad/40">
        <CardHeader>
          <CardTitle className="text-bad">No schedule loaded</CardTitle>
        </CardHeader>
        <CardContent className="text-sm text-ink-300">
          Seed the season first with <code>npm run db:seed</code>.
        </CardContent>
      </Card>
    );
  }

  const userState = entries.find((e) => e.entry.isUser) ?? null;

  return (
    <PoolStateView
      weeks={weeks}
      initial={{
        season,
        week,
        entries,
        inventoryEdges: computeInventoryEdges(entries, userState),
        totals: {
          original: entries.length,
          active: entries.filter((e) => e.entry.status === "ACTIVE").length,
          eliminated: entries.filter((e) => e.entry.status === "ELIMINATED").length,
        },
      }}
    />
  );
}
