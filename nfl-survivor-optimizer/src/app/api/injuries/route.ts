import { prisma } from "@/lib/db";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { normalizeTeam } from "@/lib/teams";
import { scoreInjury } from "@/lib/injuries";
import { now } from "@/lib/clock";
import type { InjuryStatus } from "@/lib/types";

export const dynamic = "force-dynamic";

const STATUSES: InjuryStatus[] = [
  "OUT",
  "DOUBTFUL",
  "QUESTIONABLE",
  "IR",
  "PUP",
  "PROBABLE",
  "ACTIVE",
];

export async function GET(request: Request) {
  const week = Number(new URL(request.url).searchParams.get("week"));
  return guard(async () => {
    const rows = await prisma.injuryReport.findMany({
      where: { season: env.season, ...(Number.isFinite(week) ? { week } : {}) },
      orderBy: [{ impactScore: "desc" }],
    });
    return { injuries: rows };
  });
}

/**
 * Manual injury entry, e.g. "Josh Allen — OUT" or "starting LT — doubtful".
 * Manual rows always supersede provider rows for the same player.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    week?: number;
    team?: string;
    playerName?: string;
    position?: string;
    status?: InjuryStatus;
    isStarter?: boolean;
    depthChartRank?: number | null;
    practiceParticipation?: string | null;
    note?: string | null;
  } | null;

  if (!body?.team || !body?.playerName || !body?.status) {
    return fail("`team`, `playerName` and `status` are required.");
  }
  if (!STATUSES.includes(body.status)) {
    return fail(`\`status\` must be one of: ${STATUSES.join(", ")}`);
  }
  const team = normalizeTeam(body.team);
  if (!team) return fail(`Unrecognised team: ${body.team}`);

  return guard(async () => {
    const week = body.week ?? 1;
    const scored = scoreInjury({
      season: env.season,
      week,
      team,
      playerName: body.playerName!.trim(),
      position: (body.position ?? "UNK").toUpperCase(),
      status: body.status!,
      practiceParticipation: body.practiceParticipation ?? null,
      depthChartRank: body.depthChartRank ?? null,
      isStarter: body.isStarter ?? false,
      note: body.note ?? null,
      source: "manual",
      manualOverride: true,
      observedAt: now().toISOString(),
    });

    const existing = await prisma.injuryReport.findFirst({
      where: {
        season: env.season,
        week,
        teamAbbr: team,
        playerName: scored.playerName,
        manualOverride: true,
      },
    });

    const data = {
      season: env.season,
      week,
      teamAbbr: team,
      playerName: scored.playerName,
      position: scored.position,
      status: scored.status,
      practiceParticipation: scored.practiceParticipation,
      depthChartRank: scored.depthChartRank,
      isStarter: scored.isStarter,
      note: scored.note,
      impact: scored.impact,
      impactScore: scored.impactScore,
      source: "manual",
      manualOverride: true,
      observedAt: now(),
    };

    const row = existing
      ? await prisma.injuryReport.update({ where: { id: existing.id }, data })
      : await prisma.injuryReport.create({ data });
    return { injury: row };
  });
}

export async function DELETE(request: Request) {
  const id = Number(new URL(request.url).searchParams.get("id"));
  if (!Number.isFinite(id)) return fail("`id` query parameter is required.");
  return guard(async () => {
    await prisma.injuryReport.delete({ where: { id } }).catch(() => undefined);
    return { ok: true };
  });
}
