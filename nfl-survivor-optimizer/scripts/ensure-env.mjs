/**
 * Create `.env` from `.env.example` on first run.
 *
 * The Prisma CLI reads DATABASE_URL from `.env` (it does not use Next.js's env
 * loading), so `prisma generate` / `prisma db push` fail with P1012 on a fresh
 * clone that has no `.env`. This runs ahead of both, so `npm install && npm run
 * dev` works with no manual setup step.
 *
 * Plain .mjs rather than TypeScript so it needs no loader, and it never
 * overwrites an existing `.env`.
 */

import { copyFileSync, existsSync } from "node:fs";
import path from "node:path";

const root = process.cwd();
const envPath = path.join(root, ".env");
const examplePath = path.join(root, ".env.example");

if (existsSync(envPath)) {
  process.exit(0);
}

if (!existsSync(examplePath)) {
  console.error(
    "[env] Neither .env nor .env.example exists. Create a .env containing at least:\n" +
      '      DATABASE_URL="file:./dev.db"',
  );
  process.exit(1);
}

copyFileSync(examplePath, envPath);
console.log(
  "[env] Created .env from .env.example. Every API key in it is optional — " +
    "fill them in and restart to enable live odds and injury data.",
);
