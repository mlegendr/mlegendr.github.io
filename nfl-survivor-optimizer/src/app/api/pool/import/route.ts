import { importPool, type PoolExport } from "@/lib/pool";
import { guard, fail } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as
    | (PoolExport & { replace?: boolean })
    | null;
  if (!body?.picks) return fail("Expected an exported pool JSON document with a `picks` array.");
  return guard(async () => importPool(body, body.replace !== false));
}
