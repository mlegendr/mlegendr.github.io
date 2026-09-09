import { guard } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildRetrospective } from "@/lib/gametheory/snapshot";

export const dynamic = "force-dynamic";

/** Predicted vs actual field picks, graded from the stored pre-lock snapshots. */
export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return { weeks: await buildRetrospective(pool.id, env.season) };
  });
}
