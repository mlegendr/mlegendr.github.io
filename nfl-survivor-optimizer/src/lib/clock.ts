/**
 * "Now" for the whole application.
 *
 * Pinned by APP_CLOCK when set, so demos, tests and screenshots are reproducible
 * without touching the machine's system time.
 */

export function now(): Date {
  const pinned = process.env.APP_CLOCK?.trim();
  if (pinned) {
    const t = Date.parse(pinned);
    if (Number.isFinite(t)) return new Date(t);
  }
  return new Date();
}

export function hasStarted(kickoff: Date | string, reference: Date = now()): boolean {
  const t = typeof kickoff === "string" ? Date.parse(kickoff) : kickoff.getTime();
  return Number.isFinite(t) && t <= reference.getTime();
}

export function minutesAgo(when: Date | string | null | undefined, reference: Date = now()): number | null {
  if (!when) return null;
  const t = typeof when === "string" ? Date.parse(when) : when.getTime();
  if (!Number.isFinite(t)) return null;
  return (reference.getTime() - t) / 60000;
}

export function humanizeAge(when: Date | string | null | undefined, reference: Date = now()): string {
  const mins = minutesAgo(when, reference);
  if (mins == null) return "never";
  if (mins < 1) return "just now";
  if (mins < 60) return `${Math.round(mins)} min ago`;
  const hours = mins / 60;
  if (hours < 36) return `${Math.round(hours)} h ago`;
  return `${Math.round(hours / 24)} d ago`;
}
