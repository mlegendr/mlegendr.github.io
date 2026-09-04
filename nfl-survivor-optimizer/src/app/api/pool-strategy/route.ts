import { buildAnalysis } from "@/lib/engine";
import { computePoolStrategy } from "@/lib/pool-strategy";
import { getOrCreatePool, updateSettings } from "@/lib/pool";
import { guard, fail } from "@/lib/api";
import { env } from "@/lib/env";
import { normalizeTeam } from "@/lib/teams";
import type { HorizonKey } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    remainingEntries?: number;
    pickPopularity?: Record<string, number>;
    riskPreference?: number;
    horizon?: HorizonKey;
    persist?: boolean;
  } | null;
  if (!body) return fail("A JSON body is required.");

  const popularity: Record<string, number> = {};
  for (const [k, v] of Object.entries(body.pickPopularity ?? {})) {
    const team = normalizeTeam(k);
    const n = Number(v);
    if (!team) return fail(`Unrecognised team in pickPopularity: ${k}`);
    if (!Number.isFinite(n) || n < 0 || n > 1) {
      return fail(`pickPopularity[${k}] must be a share between 0 and 1.`);
    }
    popularity[team] = n;
  }

  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    const horizon = body.horizon ?? (String(pool.settings.defaultHorizon) as HorizonKey);
    const snapshot = await buildAnalysis({ horizonOverride: horizon });

    if (body.persist) {
      await updateSettings(pool.id, {
        poolStrategyEnabled: true,
        remainingEntries: body.remainingEntries ?? null,
        pickPopularity: popularity,
        riskPreference: body.riskPreference ?? pool.settings.riskPreference,
      });
    }

    return computePoolStrategy({
      candidates: snapshot.candidates,
      horizon,
      remainingEntries: body.remainingEntries ?? pool.settings.remainingEntries ?? 0,
      pickPopularity:
        Object.keys(popularity).length > 0 ? popularity : pool.settings.pickPopularity,
      riskPreference: body.riskPreference ?? pool.settings.riskPreference,
    });
  });
}
