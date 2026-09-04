import { buildAnalysis } from "@/lib/engine";
import { guard, intParam } from "@/lib/api";
import type { HorizonKey } from "@/lib/types";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const url = new URL(request.url);
  const horizon = url.searchParams.get("horizon");
  const validHorizon: HorizonKey | null =
    horizon === "3" || horizon === "6" || horizon === "9" || horizon === "season" ? horizon : null;

  return guard(() =>
    buildAnalysis({
      includeRobustness: url.searchParams.get("robustness") === "1",
      simulations: intParam(url.searchParams.get("simulations"), 1500) ?? 1500,
      weekOverride: intParam(url.searchParams.get("week"), null),
      horizonOverride: validHorizon,
    }),
  );
}
