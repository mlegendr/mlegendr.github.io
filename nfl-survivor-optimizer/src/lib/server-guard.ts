/**
 * Runtime guard for server-only modules.
 *
 * Modules that read API keys, touch SQLite or hit the filesystem import this.
 * Next.js already refuses to bundle them into a client component (they pull in
 * `@prisma/client` and `node:fs`), and this makes the intent explicit and
 * enforced at runtime too.
 *
 * We use this rather than the `server-only` package because the same modules are
 * imported by the standalone CLI scripts (`npm run db:seed`), which run in plain
 * Node where `server-only` unconditionally throws.
 */

if (typeof window !== "undefined") {
  throw new Error(
    "This module is server-only and must never be imported from browser code. " +
      "It has access to API keys and the local database.",
  );
}

export {};
