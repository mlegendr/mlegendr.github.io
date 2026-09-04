import { prisma } from "@/lib/db";
import { deletePick, getOrCreatePool, gradePicks, listPicks, upsertPick } from "@/lib/pool";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { normalizeTeam } from "@/lib/teams";
import { hasStarted } from "@/lib/clock";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return { poolId: pool.id, picks: await listPicks(pool.id, pool.season) };
  });
}

/**
 * Confirm (or provisionally record) a week's pick.
 *
 * `confirmed: true` is the irreversible-feeling action: from that moment the
 * team is excluded from every recommendation and every future path, and it
 * survives restarts because it lives in SQLite.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    week?: number;
    team?: string;
    confirmed?: boolean;
    note?: string | null;
    force?: boolean;
  } | null;

  if (!body?.week || !body?.team) return fail("`week` and `team` are required.");
  const team = normalizeTeam(body.team);
  if (!team) return fail(`Unrecognised team: ${body.team}`);

  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    const season = pool.season;

    const game = await prisma.game.findFirst({
      where: {
        season,
        week: body.week,
        seasonType: "REG",
        OR: [{ homeTeamAbbr: team }, { awayTeamAbbr: team }],
      },
    });
    if (!game) {
      throw new Error(`${team} has no regular-season game in week ${body.week} (bye week).`);
    }

    // Guard the two rules that make a pick illegal, unless explicitly forced.
    const alreadyUsed = await prisma.pick.findFirst({
      where: { poolId: pool.id, season, teamAbbr: team, confirmed: true, NOT: { week: body.week } },
    });
    if (alreadyUsed && !body.force) {
      throw new Error(
        `${team} was already confirmed in week ${alreadyUsed.week} and cannot be used again.`,
      );
    }
    if (body.confirmed && hasStarted(game.kickoff) && !body.force) {
      throw new Error(
        `${team}'s week ${body.week} game has already kicked off. Pass force:true to record it anyway.`,
      );
    }

    const opponent = game.homeTeamAbbr === team ? game.awayTeamAbbr : game.homeTeamAbbr;
    const pick = await upsertPick({
      poolId: pool.id,
      season,
      week: body.week!,
      team,
      opponent,
      gameId: game.id,
      confirmed: body.confirmed ?? false,
      note: body.note ?? null,
    });
    await gradePicks(pool.id, season, pool.settings.tieCountsAsLoss);
    return { pick, picks: await listPicks(pool.id, season) };
  });
}

export async function DELETE(request: Request) {
  const url = new URL(request.url);
  const week = Number(url.searchParams.get("week"));
  if (!Number.isFinite(week)) return fail("`week` query parameter is required.");
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    await deletePick(pool.id, pool.season, week);
    return { picks: await listPicks(pool.id, pool.season) };
  });
}
