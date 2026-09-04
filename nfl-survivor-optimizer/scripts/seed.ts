/**
 * Seed the local database with the current season.
 *
 *   npm run db:seed              # 2026 (or $NFL_SEASON)
 *   npm run db:seed -- --season 2025
 *   npm run db:seed -- --offline # teams only, no network
 *
 * Idempotent: safe to re-run. Confirmed picks are never touched.
 */

import { config } from "dotenv";
import { prisma } from "../src/lib/db";
import { ensureTeams, refreshAll, loadCanonicalGames } from "../src/lib/refresh";
import { getOrCreatePool } from "../src/lib/pool";
import { detectCurrentWeek, regularSeasonWeeks } from "../src/lib/schedule-utils";
import { TEAM_ABBRS } from "../src/lib/teams";

config({ path: ".env", quiet: true });

async function main() {
  const args = process.argv.slice(2);
  const seasonArg = args.indexOf("--season");
  const season = seasonArg >= 0 ? Number(args[seasonArg + 1]) : Number(process.env.NFL_SEASON ?? 2026);
  const offline = args.includes("--offline") || process.env.OFFLINE_MODE === "1";

  console.log(`Seeding NFL Survivor Optimizer for the ${season} season...`);

  await ensureTeams();
  console.log(`  teams: ${await prisma.team.count()} / ${TEAM_ABBRS.length}`);

  const pool = await getOrCreatePool(season);
  console.log(`  pool:  ${pool.name} (${pool.id})`);

  if (offline) {
    console.log("  OFFLINE_MODE — skipping provider fetches.");
  } else {
    const report = await refreshAll(season);
    for (const o of report.outcomes) {
      const flag = o.ok ? (o.degraded ? "DEGRADED" : "ok") : "FAILED";
      console.log(`  ${o.key.padEnd(9)} ${flag.padEnd(9)} ${o.label} — ${o.records} record(s)`);
      if (o.message) console.log(`             ${o.message}`);
    }
  }

  const games = await loadCanonicalGames(season);
  const weeks = regularSeasonWeeks(games);
  const teams = new Set(games.flatMap((g) => [g.homeTeam, g.awayTeam]));
  console.log(
    `\n  ${games.length} games, weeks ${weeks[0] ?? "-"}-${weeks[weeks.length - 1] ?? "-"}, ${teams.size} distinct teams`,
  );
  if (games.length > 0) console.log(`  current week: ${detectCurrentWeek(games)}`);

  if (games.length > 0 && teams.size !== 32) {
    console.error(`  WARNING: expected 32 teams in the schedule, found ${teams.size}`);
    process.exitCode = 1;
  }
  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error(err);
  await prisma.$disconnect();
  process.exit(1);
});
