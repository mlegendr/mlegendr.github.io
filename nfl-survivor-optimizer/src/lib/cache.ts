/**
 * TTL cache backed by SQLite.
 *
 * Provider quotas are small and some payloads (Sleeper's full player database is
 * ~10 MB) are expensive to fetch, so every outbound call goes through here. The
 * cache survives restarts, which is also what lets the app stay useful offline.
 */

import { prisma } from "./db";
import { now } from "./clock";

export interface CachedValue<T> {
  value: T;
  createdAt: Date;
  fresh: boolean;
}

export async function cacheGet<T>(key: string, opts?: { allowStale?: boolean }): Promise<CachedValue<T> | null> {
  const row = await prisma.cacheEntry.findUnique({ where: { key } });
  if (!row) return null;
  const fresh = row.expiresAt.getTime() > now().getTime();
  if (!fresh && !opts?.allowStale) return null;
  try {
    return { value: JSON.parse(row.value) as T, createdAt: row.createdAt, fresh };
  } catch {
    return null;
  }
}

export async function cacheSet<T>(key: string, value: T, ttlSeconds: number): Promise<void> {
  const expiresAt = new Date(now().getTime() + ttlSeconds * 1000);
  const payload = JSON.stringify(value);
  await prisma.cacheEntry.upsert({
    where: { key },
    create: { key, value: payload, expiresAt, createdAt: now() },
    update: { value: payload, expiresAt, createdAt: now() },
  });
}

/**
 * Fetch-through cache. On a provider error we fall back to a stale entry rather
 * than failing the request, and report `stale: true` so the UI can say so.
 */
export async function cached<T>(
  key: string,
  ttlSeconds: number,
  loader: () => Promise<T>,
  opts?: { force?: boolean },
): Promise<{ value: T; fromCache: boolean; stale: boolean; createdAt: Date }> {
  if (!opts?.force) {
    const hit = await cacheGet<T>(key);
    if (hit) return { value: hit.value, fromCache: true, stale: false, createdAt: hit.createdAt };
  }
  try {
    const value = await loader();
    await cacheSet(key, value, ttlSeconds);
    return { value, fromCache: false, stale: false, createdAt: now() };
  } catch (err) {
    const stale = await cacheGet<T>(key, { allowStale: true });
    if (stale) return { value: stale.value, fromCache: true, stale: true, createdAt: stale.createdAt };
    throw err;
  }
}

export async function cacheInvalidate(prefix: string): Promise<number> {
  const res = await prisma.cacheEntry.deleteMany({ where: { key: { startsWith: prefix } } });
  return res.count;
}

/** Rough cadence guidance, in seconds. Tightened automatically on game day. */
export const TTL = {
  schedule: 12 * 3600,
  scheduleGameDay: 30 * 60,
  odds: 15 * 60,
  oddsGameDay: 3 * 60,
  injuries: 3 * 3600,
  injuriesGameDay: 20 * 60,
  playerDatabase: 24 * 3600,
  weather: 3 * 3600,
  weatherGameDay: 45 * 60,
  teamStats: 6 * 3600,
  historical: 7 * 24 * 3600,
} as const;
