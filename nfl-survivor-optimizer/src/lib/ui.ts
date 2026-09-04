/** Presentation helpers shared by the client components. */

import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

export function pct(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${(x * 100).toFixed(digits)}%`;
}

export function signed(x: number | null | undefined, digits = 1): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return `${x >= 0 ? "+" : ""}${x.toFixed(digits)}`;
}

export function ml(x: number | null | undefined): string {
  if (x == null || !Number.isFinite(x)) return "—";
  return x > 0 ? `+${x}` : String(x);
}

/**
 * Colour ramp for a win probability. Cool -> warm with rising luminance, so it
 * survives greyscale printing and the common colour-vision deficiencies.
 */
export function probColor(p: number | null | undefined): string {
  if (p == null || !Number.isFinite(p)) return "rgb(30,39,57)";
  const q = Math.max(0, Math.min(1, p));
  // 0.30 -> deep slate blue, 0.50 -> neutral, 0.90 -> bright amber
  const stops: [number, [number, number, number]][] = [
    [0.2, [30, 45, 80]],
    [0.4, [40, 66, 104]],
    [0.5, [52, 62, 84]],
    [0.6, [86, 84, 66]],
    [0.7, [126, 105, 55]],
    [0.8, [170, 130, 46]],
    [0.9, [214, 158, 43]],
    [1.0, [242, 186, 60]],
  ];
  let lo = stops[0];
  let hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (q >= stops[i][0] && q <= stops[i + 1][0]) {
      lo = stops[i];
      hi = stops[i + 1];
      break;
    }
  }
  const t = hi[0] === lo[0] ? 0 : (q - lo[0]) / (hi[0] - lo[0]);
  const c = lo[1].map((v, i) => Math.round(v + (hi[1][i] - v) * t));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

export function confidenceClass(c: string): string {
  return c === "HIGH"
    ? "text-good border-good/40 bg-good/10"
    : c === "MEDIUM"
      ? "text-warn border-warn/40 bg-warn/10"
      : "text-bad border-bad/40 bg-bad/10";
}

export function impactClass(i: string): string {
  return i === "CRITICAL"
    ? "text-bad border-bad/50 bg-bad/15"
    : i === "HIGH"
      ? "text-warn border-warn/50 bg-warn/15"
      : i === "MODERATE"
        ? "text-ink-200 border-ink-500 bg-ink-700"
        : "text-ink-400 border-ink-600 bg-ink-800";
}

export const UNAVAILABLE_LABEL: Record<string, string> = {
  USED: "Already used — permanently excluded",
  BYE: "On bye this week",
  NO_GAME: "No scheduled game this week",
  STARTED: "Game already kicked off",
  COMPLETED: "Game finished",
  LOCKED_PICK: "Your confirmed pick for this week",
};
