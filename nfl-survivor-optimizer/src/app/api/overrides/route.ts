import { deleteOverride, listOverrides, upsertOverride, type OverrideScope } from "@/lib/overrides";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { normalizeTeam } from "@/lib/teams";

export const dynamic = "force-dynamic";

const SCOPES: OverrideScope[] = [
  "WIN_PROBABILITY",
  "SPREAD",
  "MONEYLINE",
  "INJURY",
  "CURRENT_WEEK",
];

export async function GET() {
  return guard(async () => ({ overrides: await listOverrides(env.season) }));
}

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    scope?: OverrideScope;
    week?: number | null;
    gameId?: string | null;
    team?: string | null;
    value?: Record<string, unknown>;
    note?: string | null;
  } | null;

  if (!body?.scope || !SCOPES.includes(body.scope)) {
    return fail(`\`scope\` must be one of: ${SCOPES.join(", ")}`);
  }
  if (!body.value) return fail("`value` is required.");

  if (body.scope === "WIN_PROBABILITY") {
    const p = Number(body.value.probability);
    if (!Number.isFinite(p) || p <= 0 || p >= 1) {
      return fail("WIN_PROBABILITY overrides need `value.probability` strictly between 0 and 1.");
    }
    if (!body.team || body.week == null) {
      return fail("WIN_PROBABILITY overrides need both `team` and `week`.");
    }
  }

  const team = body.team ? normalizeTeam(body.team) : null;
  if (body.team && !team) return fail(`Unrecognised team: ${body.team}`);

  return guard(async () =>
    upsertOverride({
      season: env.season,
      week: body.week ?? null,
      scope: body.scope!,
      gameId: body.gameId ?? null,
      teamAbbr: team,
      value: body.value!,
      note: body.note ?? null,
    }),
  );
}

export async function DELETE(request: Request) {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return fail("`id` query parameter is required.");
  return guard(async () => {
    await deleteOverride(id);
    return { overrides: await listOverrides(env.season) };
  });
}
