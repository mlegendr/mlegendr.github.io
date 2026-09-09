import { guard, fail, intParam } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildPoolEquity } from "@/lib/gametheory/service";
import { savePreLockSnapshot } from "@/lib/gametheory/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Run the multi-entry tournament. This is the expensive endpoint, so it is
 * explicitly invoked rather than run on every dashboard render.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    simulations?: number;
    seed?: number;
    sensitivity?: boolean;
    snapshot?: boolean;
  };
  const simulations = body.simulations
    ? Math.max(200, Math.min(100_000, Math.round(body.simulations)))
    : undefined;

  return guard(async () => {
    const result = await buildPoolEquity({
      simulations,
      seed: body.seed,
      runSensitivity: body.sensitivity ?? true,
    });
    let snapshot: { created: boolean; id: string } | null = null;
    if (body.snapshot) {
      const pool = await getOrCreatePool(env.season);
      snapshot = await savePreLockSnapshot(pool.id, result);
    }
    return {
      analysis: result.analysis,
      explanation: result.explanation,
      objective: result.objective,
      settings: result.settings,
      survival: {
        team: result.survivalSnapshot.candidates[0]?.team ?? null,
        winProbability: result.survivalSnapshot.candidates[0]?.currentWinProb ?? null,
        pathSurvival: result.survivalSnapshot.candidates[0]?.pathSurvival ?? {},
      },
      snapshot,
    };
  });
}

export async function GET(request: Request) {
  const url = new URL(request.url);
  const sims = intParam(url.searchParams.get("simulations"), null);
  if (sims != null && (sims < 200 || sims > 100_000)) {
    return fail("`simulations` must be between 200 and 100000.");
  }
  return guard(async () => {
    const result = await buildPoolEquity({
      simulations: sims ?? undefined,
      runSensitivity: url.searchParams.get("sensitivity") !== "0",
    });
    return {
      analysis: result.analysis,
      explanation: result.explanation,
      objective: result.objective,
      settings: result.settings,
    };
  });
}
