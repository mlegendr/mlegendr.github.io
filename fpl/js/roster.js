/**
 * Resolves a squad written down by name into snapshot player ids.
 *
 * A squad is easiest to record the way it appears in the FPL app - a surname
 * and a club - but everything downstream needs ids and prices. Matching is
 * deliberately conservative: accents, punctuation and the German sharp s are
 * normalised away, but a name that could mean two different players is
 * reported as ambiguous rather than guessed at.
 */

import { GKP, DEF, MID, FWD, POSITIONS } from './rules.js';

const POSITION_CODES = { GKP, DEF, MID, FWD, GK: GKP, G: GKP, D: DEF, M: MID, F: FWD };

/** Lowercase, strip accents, expand ß, drop punctuation, collapse whitespace. */
export function normalise(text) {
  return String(text)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/ß/g, 'ss')
    .replace(/[.'’\-]/g, ' ')
    .replace(/[^a-zA-Z0-9 ]/g, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, ' ');
}

const lastToken = (text) => normalise(text).split(' ').filter(Boolean).at(-1) ?? '';

/**
 * How well a snapshot player matches a written-down name. Higher is better;
 * zero means no match at all.
 */
export function matchScore(player, query) {
  const q = normalise(query);
  if (!q) return 0;
  const web = normalise(player.name);
  const full = normalise(player.fullName);

  if (web === q || full === q) return 100;
  if (lastToken(player.name) === q || lastToken(player.fullName) === q) return 85;
  if (web.includes(q) || q.includes(web)) return 75;
  if (full.includes(q)) return 65;
  if (lastToken(query) && lastToken(query) === lastToken(player.fullName)) return 55;
  return 0;
}

function clubMatches(snapshot, player, club) {
  if (!club) return true;
  const team = snapshot.team(player.teamId);
  if (!team) return false;
  const c = normalise(club);
  return normalise(team.short) === c || normalise(team.name) === c || normalise(team.name).startsWith(c);
}

/**
 * Resolve one written entry.
 * @returns {{status:'resolved'|'ambiguous'|'missing', player?, candidates?, entry, note?}}
 */
export function resolveEntry(snapshot, entry) {
  const position = POSITION_CODES[String(entry.position ?? '').toUpperCase()] ?? null;

  const score = (pool) => pool
    .map((player) => ({ player, score: matchScore(player, entry.name) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || b.player.totalPoints - a.player.totalPoints);

  const all = [...snapshot.players.values()]
    .filter((p) => (position ? p.position === position : true));

  let ranked = score(all.filter((p) => clubMatches(snapshot, p, entry.club)));
  let note = null;

  // Fall back to ignoring the club, which happens after a transfer between clubs.
  if (ranked.length === 0 && entry.club) {
    ranked = score(all);
    if (ranked.length) note = `No ${entry.club} player matched, so the club hint was ignored.`;
  }

  if (ranked.length === 0) return { status: 'missing', entry };

  const best = ranked[0];
  const tied = ranked.filter((x) => x.score === best.score);
  if (tied.length > 1) {
    return { status: 'ambiguous', entry, candidates: tied.map((x) => x.player), note };
  }
  return { status: 'resolved', entry, player: best.player, score: best.score, note };
}

/**
 * Resolve a whole squad file.
 * @returns {{resolved:[], ambiguous:[], missing:[], notes:string[], playerIds:number[], ok:boolean}}
 */
export function resolveSquad(snapshot, squadFile) {
  const entries = squadFile.picks ?? [];
  const resolved = [];
  const ambiguous = [];
  const missing = [];
  const notes = [];

  const taken = new Set();
  for (const entry of entries) {
    const result = resolveEntry(snapshot, entry);
    if (result.note) notes.push(`${entry.name}: ${result.note}`);

    if (result.status === 'resolved') {
      if (taken.has(result.player.id)) {
        ambiguous.push({ ...result, status: 'ambiguous', candidates: [result.player],
          note: 'Matched a player already claimed by another entry.' });
        continue;
      }
      taken.add(result.player.id);
      resolved.push(result);
    } else if (result.status === 'ambiguous') {
      ambiguous.push(result);
    } else {
      missing.push(result);
    }
  }

  return {
    resolved, ambiguous, missing, notes,
    playerIds: resolved.map((r) => r.player.id),
    ok: ambiguous.length === 0 && missing.length === 0 && resolved.length === entries.length,
  };
}

/** The starting XI, bench order and armbands recorded in a squad file. */
export function resolveSelections(resolution, squadFile) {
  const byEntry = new Map(resolution.resolved.map((r) => [r.entry, r.player]));
  const idOfName = (name) => {
    if (!name) return null;
    const hit = resolution.resolved.find((r) => normalise(r.entry.name) === normalise(name));
    return hit?.player.id ?? null;
  };

  const starters = [];
  const bench = [];
  for (const entry of squadFile.picks ?? []) {
    const player = byEntry.get(entry);
    if (!player) continue;
    if (entry.start) starters.push(player.id);
    else bench.push({ id: player.id, order: entry.benchOrder ?? 99 });
  }
  bench.sort((a, b) => a.order - b.order);

  return {
    startingXi: starters,
    bench: bench.map((b) => b.id),
    captain: idOfName(squadFile.captain),
    viceCaptain: idOfName(squadFile.viceCaptain),
  };
}

/** Human-readable summary of a resolution, for the UI to show before applying. */
export function describeResolution(snapshot, resolution) {
  const lines = [];
  for (const r of resolution.resolved) {
    lines.push(`✓ ${r.entry.name} → ${r.player.label}, ${POSITIONS[r.player.position].short}`);
  }
  for (const a of resolution.ambiguous) {
    const shown = a.candidates.slice(0, 4).map((p) => p.label).join(' / ');
    const extra = a.candidates.length > 4 ? ` and ${a.candidates.length - 4} more` : '';
    lines.push(`? ${a.entry.name} → ambiguous: ${shown}${extra}`);
  }
  for (const m of resolution.missing) {
    lines.push(`✗ ${m.entry.name} (${m.entry.club ?? '?'}) → no match in this snapshot`);
  }
  return lines;
}
