import { guard, fail } from "@/lib/api";
import {
  clearEntryStatusOverride,
  setEntryStatusOverride,
} from "@/lib/gametheory/entries";
import type { EntryStatus } from "@/lib/gametheory/types";

export const dynamic = "force-dynamic";

const STATUSES: EntryStatus[] = ["ACTIVE", "ELIMINATED", "UNKNOWN", "WINNER"];

/** Manual status correction. Always flagged so the UI can label it. */
export async function POST(request: Request) {
  const body = (await request.json().catch(() => null)) as {
    id?: string;
    status?: EntryStatus;
    eliminatedWeek?: number | null;
    reason?: string | null;
    clear?: boolean;
  } | null;
  if (!body?.id) return fail("`id` is required.");
  if (body.clear) {
    return guard(async () => clearEntryStatusOverride(body.id!));
  }
  if (!body.status || !STATUSES.includes(body.status)) {
    return fail(`\`status\` must be one of: ${STATUSES.join(", ")}`);
  }
  return guard(async () =>
    setEntryStatusOverride(
      body.id!,
      body.status!,
      body.eliminatedWeek ?? null,
      body.reason ?? "Manually set",
    ),
  );
}
