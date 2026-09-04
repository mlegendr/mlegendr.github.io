/**
 * Post-install sanity check for Tailwind's native binding.
 *
 * Tailwind v4 compiles CSS through a platform-specific Rust binary shipped as an
 * optional dependency. npm intermittently skips installing the one for the
 * current machine (npm/cli#4828), and the failure then surfaces much later as a
 * confusing webpack error on the first page load. Catching it here turns that
 * into an actionable message at install time.
 *
 * This is advisory only: it must never fail `npm install`, so every path exits 0.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

try {
  // Loading the package is what actually resolves the native .node binding.
  require("@tailwindcss/oxide");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/native binding|MODULE_NOT_FOUND|Cannot find module/i.test(message)) {
    process.exit(0); // some unrelated problem; not ours to diagnose
  }
  console.warn(
    [
      "",
      "  ⚠  Tailwind's native binding (@tailwindcss/oxide) did not install for",
      `     ${process.platform}-${process.arch}. This is a known npm bug with optional`,
      "     dependencies (https://github.com/npm/cli/issues/4828), not a problem",
      "     with this project. Without it the app fails to build its CSS.",
      "",
      "     Fix:",
      "       rm -rf node_modules package-lock.json .next",
      "       npm install",
      "",
    ].join("\n"),
  );
}

process.exit(0);
