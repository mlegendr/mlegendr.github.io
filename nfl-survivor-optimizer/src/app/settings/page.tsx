import { getOrCreatePool } from "@/lib/pool";
import { listOverrides } from "@/lib/overrides";
import { loadCanonicalGames } from "@/lib/refresh";
import { prisma } from "@/lib/db";
import { env, providerAvailability } from "@/lib/env";
import { detectCurrentWeek } from "@/lib/schedule-utils";
import { SettingsForm } from "@/components/SettingsForm";

export const dynamic = "force-dynamic";

export default async function SettingsPage() {
  const pool = await getOrCreatePool(env.season);
  const overrides = await listOverrides(env.season);
  const games = await loadCanonicalGames(env.season);
  const manualInjuries = await prisma.injuryReport.findMany({
    where: { season: env.season, manualOverride: true },
    orderBy: { updatedAt: "desc" },
  });

  return (
    <SettingsForm
      poolName={pool.name}
      settings={pool.settings}
      providers={providerAvailability()}
      overrides={overrides}
      detectedWeek={games.length ? detectCurrentWeek(games) : 1}
      manualInjuries={manualInjuries.map((i) => ({
        id: i.id,
        week: i.week,
        team: i.teamAbbr,
        playerName: i.playerName,
        position: i.position,
        status: i.status,
        impact: i.impact,
      }))}
      games={games
        .filter((g) => !g.completed)
        .slice(0, 300)
        .map((g) => ({ id: g.id, week: g.week, home: g.homeTeam, away: g.awayTeam }))}
    />
  );
}
