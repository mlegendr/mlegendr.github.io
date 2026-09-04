import { buildAnalysis } from "@/lib/engine";
import { guard, fail } from "@/lib/api";
import type { HorizonKey } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

/**
 * Monte Carlo robustness on demand. Kept off the default dashboard render
 * because a few thousand re-optimisations is the slowest thing the app does.
 */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    simulations?: number;
    horizon?: HorizonKey;
  };
  const simulations = Math.max(100, Math.min(5000, body.simulations ?? 2000));
  const horizon = body.horizon;
  if (horizon && !["3", "6", "9", "season"].includes(horizon)) {
    return fail("`horizon` must be one of 3, 6, 9, season.");
  }
  return guard(async () => {
    const snapshot = await buildAnalysis({
      includeRobustness: true,
      simulations,
      horizonOverride: horizon ?? null,
    });
    return {
      simulations,
      horizon: horizon ?? String(snapshot.settings.defaultHorizon),
      robustness: snapshot.robustness ?? [],
      label: snapshot.robustnessLabel,
      recommended: snapshot.candidates[0]?.team ?? null,
    };
  });
}
