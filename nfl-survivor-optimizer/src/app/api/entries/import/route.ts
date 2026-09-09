import { prisma } from "@/lib/db";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { loadCanonicalGames } from "@/lib/refresh";
import { byeTeams, regularSeasonWeeks } from "@/lib/schedule-utils";
import { buildImportPreview } from "@/lib/gametheory/import";
import { gradeEntries, setEntryPick, upsertEntry } from "@/lib/gametheory/entries";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * CSV import of pool-entry history.
 *
 * `commit: false` (the default) returns a preview only. Nothing is written
 * until the caller explicitly commits, and a commit is refused while blocking
 * issues remain.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    csv?: string;
    commit?: boolean;
    replaceExisting?: boolean;
    /** The CSV entry name that is YOUR entry, e.g. "Me". Optional. */
    userEntryName?: string | null;
  } | null;
  if (!body?.csv?.trim()) return fail("`csv` is required.");

  return guard(async () => {
    const season = env.season;
    const pool = await getOrCreatePool(season);
    const games = await loadCanonicalGames(season);
    const weeks = regularSeasonWeeks(games);
    const maxWeek = weeks[weeks.length - 1] ?? 18;

    const byeTeamsByWeek = new Map(weeks.map((w) => [w, byeTeams(games, w)]));

    const existing = await prisma.poolEntry.findMany({ where: { poolId: pool.id, season } });
    const eliminatedWeekByEntry = new Map(
      existing
        .filter((e) => e.eliminatedWeek != null)
        .map((e) => [e.displayName, e.eliminatedWeek as number]),
    );

    const preview = buildImportPreview(body.csv!, {
      season,
      maxWeek,
      byeTeamsByWeek,
      eliminatedWeekByEntry,
    });

    if (!body.commit) return { preview, committed: false };
    if (!preview.committable) {
      return {
        preview,
        committed: false,
        error: "Import blocked: resolve the errors listed in the preview first.",
      };
    }

    if (body.replaceExisting) {
      // Opponent entries only — never touch the user's own entry.
      const opponents = existing.filter((e) => !e.isUser);
      await prisma.entryPick.deleteMany({
        where: { poolEntryId: { in: opponents.map((e) => e.id) }, season },
      });
    }

    let createdEntries = 0;
    let writtenPicks = 0;
    const idByName = new Map<string, string>();

    const userRow = existing.find((x) => x.isUser) ?? null;
    const userName = body.userEntryName?.trim() || null;

    for (const e of preview.entries) {
      // A CSV row the caller has identified as their own entry is merged into
      // the existing user entry rather than becoming a second competitor.
      if (userName && e.name === userName && userRow) {
        idByName.set(e.name, userRow.id);
        if (e.owner && !userRow.ownerName) {
          await prisma.poolEntry.update({
            where: { id: userRow.id },
            data: { ownerName: e.owner },
          });
        }
        continue;
      }
      const existingRow = existing.find((x) => x.displayName === e.name);
      const entry = await upsertEntry({
        poolId: pool.id,
        season,
        displayName: e.name,
        ownerName: e.owner,
        isUser: existingRow?.isUser ?? false,
      });
      idByName.set(e.name, entry.id);
      if (!existingRow) createdEntries += 1;
    }

    for (const row of preview.rows) {
      const entryId = idByName.get(row.entry);
      if (!entryId) continue;
      // The user's own picks stay owned by the legacy Pick table, which the
      // survival optimizer reads; importing must not fight that projection.
      if (userRow && entryId === userRow.id) continue;
      await setEntryPick({
        entryId,
        season,
        week: row.week,
        team: row.team,
        source: "CSV_IMPORT",
        isKnown: true,
      });
      writtenPicks += 1;
    }

    const graded = await gradeEntries(pool.id, season, pool.settings.tieCountsAsLoss);

    return {
      preview,
      committed: true,
      createdEntries,
      writtenPicks,
      gradedPicks: graded.gradedPicks,
      eliminated: graded.eliminated,
    };
  });
}
