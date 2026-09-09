import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { deleteEntryPick, gradeEntries, setEntryPick } from "@/lib/gametheory/entries";
import type { PickSource } from "@/lib/gametheory/types";

export const dynamic = "force-dynamic";

/**
 * Record one entry's selection. `isKnown` distinguishes a pick the user has
 * actually observed (which overrides the predicted distribution) from anything
 * else.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    entryId?: string;
    week?: number;
    team?: string;
    isKnown?: boolean;
    source?: PickSource;
  } | null;
  if (!body?.entryId || !body.week || !body.team) {
    return fail("`entryId`, `week` and `team` are required.");
  }
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    const pick = await setEntryPick({
      entryId: body.entryId!,
      season: env.season,
      week: body.week!,
      team: body.team!,
      isKnown: body.isKnown ?? true,
      source: body.source ?? "MANUAL_OVERRIDE",
    });
    await gradeEntries(pool.id, env.season, pool.settings.tieCountsAsLoss);
    return { pick };
  });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const entryId = url.searchParams.get("entryId");
  const week = Number(url.searchParams.get("week"));
  if (!entryId || !Number.isFinite(week)) return fail("`entryId` and `week` are required.");
  return guard(async () => {
    await deleteEntryPick(entryId, env.season, week);
    const pool = await getOrCreatePool(env.season);
    await gradeEntries(pool.id, env.season, pool.settings.tieCountsAsLoss);
    return { ok: true };
  });
}
