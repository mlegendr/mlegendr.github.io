import { guard } from "@/lib/api";
import { env } from "@/lib/env";
import { getOrCreatePool } from "@/lib/pool";
import { buildPoolEquity } from "@/lib/gametheory/service";
import { listSnapshots, savePreLockSnapshot } from "@/lib/gametheory/snapshot";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return { snapshots: await listSnapshots(pool.id, env.season) };
  });
}

/** Freeze the current decision inputs as this week's pre-lock snapshot. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as {
    simulations?: number;
    force?: boolean;
  };
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    const result = await buildPoolEquity({
      simulations: body.simulations,
      runSensitivity: true,
    });
    const saved = await savePreLockSnapshot(pool.id, result, body.force ?? false);
    return {
      ...saved,
      week: result.analysis.week,
      note: saved.created
        ? "Pre-lock snapshot stored."
        : "A pre-lock snapshot already exists for this week; it was preserved. Pass force:true to replace it.",
    };
  });
}
