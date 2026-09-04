/**
 * First-run bootstrap, wired into `predev` and `prestart`.
 *
 * If the database already has games we exit immediately, so day-to-day `npm run
 * dev` is not slowed down. On a clean checkout this is what makes
 * `npm install && npm run dev` actually produce a working app. Failures here are
 * never fatal: the dashboard has a clear "run npm run db:seed" state.
 */

import { config } from "dotenv";
import { prisma } from "../src/lib/db";
import { ensureTeams, refreshAll } from "../src/lib/refresh";

config({ path: ".env", quiet: true });

async function main() {
  const season = Number(process.env.NFL_SEASON ?? 2026);
  await ensureTeams();
  const games = await prisma.game.count({ where: { season } });
  if (games > 0) {
    console.log(`[seed] ${games} ${season} games already present — skipping.`);
    return;
  }
  console.log(`[seed] Empty database. Fetching the ${season} schedule from nflverse…`);
  const report = await refreshAll(season);
  for (const o of report.outcomes) {
    if (!o.ok) console.warn(`[seed] ${o.key}: ${o.message ?? "failed"}`);
  }
  console.log(`[seed] ${await prisma.game.count({ where: { season } })} games ready.`);
}

main()
  .catch((err) => {
    console.warn(
      `[seed] Could not seed automatically (${err instanceof Error ? err.message : err}). ` +
        "Run `npm run db:seed` once you have a network connection.",
    );
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
