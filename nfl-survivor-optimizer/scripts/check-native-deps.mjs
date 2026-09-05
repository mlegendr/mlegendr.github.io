/**
 * Post-install environment check.
 *
 * Two things go wrong on a machine with an old Node, and both surface much
 * later as confusing errors:
 *
 *  1. Next.js 15 requires Node >= 20.9. On Node 18 `next dev` refuses to start.
 *  2. Tailwind v4's native binding (@tailwindcss/oxide) declares
 *     `engines: { node: ">= 20" }`. On Node 18 npm silently SKIPS its
 *     platform-specific optional dependency, and the first page load then fails
 *     with "Cannot find native binding" — which looks like npm/cli#4828 but is
 *     really just the Node version.
 *
 * Catching both at install time turns a confusing runtime failure into an
 * actionable message. Advisory only: every path exits 0, so this can never fail
 * an install or a CI step.
 */

import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const REQUIRED_MAJOR = 20;
const REQUIRED_MINOR = 9;

const [major, minor] = process.versions.node.split(".").map(Number);
const nodeTooOld =
  major < REQUIRED_MAJOR || (major === REQUIRED_MAJOR && minor < REQUIRED_MINOR);

function banner(lines) {
  console.warn(["", ...lines.map((l) => `  ${l}`), ""].join("\n"));
}

if (nodeTooOld) {
  banner([
    `⚠  Node ${process.versions.node} is too old. This project needs Node >= ${REQUIRED_MAJOR}.${REQUIRED_MINOR}.`,
    "",
    "   Next.js 15 will refuse to start, and npm has just SKIPPED Tailwind's",
    "   native binding (@tailwindcss/oxide requires Node >= 20), so the CSS",
    "   build would fail with 'Cannot find native binding'.",
    "",
    "   Fix:",
    "     nvm install 22 && nvm use 22      # or: brew install node@22",
    "     rm -rf node_modules package-lock.json .next",
    "     npm install",
    "",
    "   The reinstall is required — the skipped binary is not fetched by",
    "   upgrading Node alone.",
  ]);
  process.exit(0);
}

try {
  // Loading the package is what actually resolves the native .node binding.
  require("@tailwindcss/oxide");
} catch (err) {
  const message = err instanceof Error ? err.message : String(err);
  if (!/native binding|MODULE_NOT_FOUND|Cannot find module/i.test(message)) {
    process.exit(0); // some unrelated problem; not ours to diagnose
  }
  banner([
    "⚠  Tailwind's native binding (@tailwindcss/oxide) did not install for",
    `   ${process.platform}-${process.arch}. Your Node version is fine, so this is the`,
    "   known npm optional-dependency bug (https://github.com/npm/cli/issues/4828).",
    "   Without it the app fails to build its CSS.",
    "",
    "   Fix:",
    "     rm -rf node_modules package-lock.json .next",
    "     npm install",
  ]);
}

process.exit(0);
