import { refreshAll } from "@/lib/refresh";
import { gradePicks, getOrCreatePool } from "@/lib/pool";
import { guard } from "@/lib/api";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export async function POST(request: Request) {
  return guard(async () => {
    const body = (await request.json().catch(() => ({}))) as { force?: boolean; week?: number };
    const season = env.season;
    const report = await refreshAll(season, { force: body.force ?? true, week: body.week });
    const pool = await getOrCreatePool(season);
    const graded = await gradePicks(pool.id, season, pool.settings.tieCountsAsLoss);
    return { ...report, gradedPicks: graded };
  });
}
