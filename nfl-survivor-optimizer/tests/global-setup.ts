/**
 * Creates a throwaway SQLite database for the persistence tests.
 * Never touches prisma/dev.db, so running the suite cannot destroy a real pool.
 */
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import path from "node:path";

const TEST_DB = path.join(process.cwd(), "prisma", "test.db");

export async function setup() {
  rmSync(TEST_DB, { force: true });
  execFileSync("npx", ["prisma", "db", "push", "--skip-generate", "--accept-data-loss"], {
    env: { ...process.env, DATABASE_URL: "file:./test.db" },
    stdio: "ignore",
  });
}

export async function teardown() {
  rmSync(TEST_DB, { force: true });
}
