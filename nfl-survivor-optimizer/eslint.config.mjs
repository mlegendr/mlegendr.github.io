/**
 * ESLint flat config.
 *
 * `next lint` is deprecated in Next 15 and removed in Next 16, so linting runs
 * through the ESLint CLI. `eslint-config-next` only ships flat-config exports
 * from v16, so FlatCompat loads its legacy shareable configs — that keeps
 * `npm run lint` working identically on both major versions.
 */

import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      "node_modules/**",
      ".next/**",
      "out/**",
      "e2e/**",
      "prisma/**",
      "data/**",
      "scripts/*.mjs",
      "next-env.d.ts",
    ],
  },
  ...compat.extends("next/core-web-vitals", "next/typescript"),
  {
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
];

export default config;
