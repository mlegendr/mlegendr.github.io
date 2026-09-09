import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { gameTheorySettingsOf, saveGameTheorySettings } from "@/lib/gametheory/service";
import type { GameTheorySettings, PoolObjective } from "@/lib/gametheory/types";

export const dynamic = "force-dynamic";

const OBJECTIVES: PoolObjective[] = [
  "EXPECTED_PRIZE_EQUITY",
  "POOL_WIN_PROBABILITY",
  "SOLE_VICTORY",
  "ANY_VICTORY",
];

export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return { settings: gameTheorySettingsOf(pool.settings) };
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Partial<GameTheorySettings> | null;
  if (!body) return fail("A JSON body is required.");
  if (body.objective && !OBJECTIVES.includes(body.objective)) {
    return fail(`\`objective\` must be one of: ${OBJECTIVES.join(", ")}`);
  }
  if (body.simulations != null && (body.simulations < 200 || body.simulations > 100_000)) {
    return fail("`simulations` must be between 200 and 100000.");
  }
  if (body.opponentTemperature != null && body.opponentTemperature <= 0) {
    return fail("`opponentTemperature` must be greater than 0.");
  }
  if (body.publicPopularity) {
    for (const [team, v] of Object.entries(body.publicPopularity)) {
      if (!Number.isFinite(v) || v < 0 || v > 1) {
        return fail(`publicPopularity[${team}] must be a share between 0 and 1.`);
      }
    }
  }
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return { settings: await saveGameTheorySettings(pool.id, body) };
  });
}
