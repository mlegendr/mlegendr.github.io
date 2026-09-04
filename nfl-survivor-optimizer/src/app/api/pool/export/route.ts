import { exportPool, getOrCreatePool } from "@/lib/pool";
import { guard } from "@/lib/api";
import { env } from "@/lib/env";

export const dynamic = "force-dynamic";

export async function GET() {
  return guard(async () => {
    const pool = await getOrCreatePool(env.season);
    return exportPool(pool.id);
  });
}
