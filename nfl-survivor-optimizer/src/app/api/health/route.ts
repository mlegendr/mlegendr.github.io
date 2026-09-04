import { prisma } from "@/lib/db";
import { guard } from "@/lib/api";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const [teams, games, picks] = await Promise.all([
      prisma.team.count(),
      prisma.game.count({ where: { season: env.season } }),
      prisma.pick.count(),
    ]);
    return { status: "ok", season: env.season, teams, games, picks, offline: env.offline };
  });
}
