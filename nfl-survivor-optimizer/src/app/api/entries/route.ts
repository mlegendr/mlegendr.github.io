import { prisma } from "@/lib/db";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildAnalysis } from "@/lib/engine";
import {
  deleteEntry,
  ensureUserEntry,
  gradeEntries,
  loadEntryStates,
  syncUserEntryFromPicks,
  upsertEntry,
} from "@/lib/gametheory/entries";
import { computeInventoryEdges } from "@/lib/gametheory/inventory";

export const dynamic = "force-dynamic";

async function currentWeek(season: number): Promise<number> {
  try {
    const snap = await buildAnalysis({ season, includeRobustness: false });
    return snap.recommendationWeek;
  } catch {
    return 1;
  }
}

export async function GET() {
  return guard(async () => {
    const season = env.season;
    const pool = await getOrCreatePool(season);
    await ensureUserEntry(pool.id, season);
    await syncUserEntryFromPicks(pool.id, season);
    await gradeEntries(pool.id, season, pool.settings.tieCountsAsLoss);
    const week = await currentWeek(season);
    const states = await loadEntryStates(pool.id, season, week);
    const userState = states.find((s) => s.entry.isUser) ?? null;
    return {
      season,
      week,
      poolId: pool.id,
      entries: states,
      inventoryEdges: computeInventoryEdges(states, userState),
      totals: {
        original: states.length,
        active: states.filter((s) => s.entry.status === "ACTIVE").length,
        eliminated: states.filter((s) => s.entry.status === "ELIMINATED").length,
      },
    };
  });
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    displayName?: string;
    ownerName?: string | null;
    notes?: string | null;
  } | null;
  if (!body?.displayName?.trim()) return fail("`displayName` is required.");
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return upsertEntry({
      poolId: pool.id,
      season: env.season,
      displayName: body.displayName!.trim(),
      ownerName: body.ownerName?.trim() || null,
      notes: body.notes ?? null,
    });
  });
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return fail("`id` query parameter is required.");
  return guard(async () => {
    const entry = await prisma.poolEntry.findUnique({ where: { id } });
    if (entry?.isUser) throw new Error("The user's own entry cannot be deleted.");
    await deleteEntry(id);
    return { ok: true };
  });
}
