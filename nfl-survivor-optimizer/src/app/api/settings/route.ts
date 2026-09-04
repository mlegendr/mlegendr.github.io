import { getOrCreatePool, updateSettings } from "@/lib/pool";
import { guard, fail } from "@/lib/api";
import { env, providerAvailability } from "@/lib/env";
import type { PoolSettings } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return {
      poolId: pool.id,
      poolName: pool.name,
      settings: pool.settings,
      // Booleans only: API keys never cross this boundary.
      providers: providerAvailability(),
    };
  });
}

export async function PATCH(request: Request) {
  const body = (await request.json().catch(() => null)) as Partial<PoolSettings> | null;
  if (!body) return fail("Body must be a JSON object of settings to change.");
  if (
    body.currentWeekOverride != null &&
    (body.currentWeekOverride < 1 || body.currentWeekOverride > 22)
  ) {
    return fail("currentWeekOverride must be between 1 and 22, or null.");
  }
  if (body.riskPreference != null && (body.riskPreference < 0 || body.riskPreference > 1)) {
    return fail("riskPreference must be between 0 and 1.");
  }
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    const settings = await updateSettings(pool.id, body);
    return { settings };
  });
}
