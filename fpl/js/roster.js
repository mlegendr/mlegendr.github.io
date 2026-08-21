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
  let tied = ranked.filter((x) => x.score === best.score);

  // A recorded price separates two players the name and club cannot.
  if (tied.length > 1 && entry.price != null) {
    const exact = tied.filter((x) => x.player.price === entry.price);
    if (exact.length === 1) tied = exact;
  }

  if (tied.length > 1) {
    return { status: 'ambiguous', entry, candidates: tied.map((x) => x.player), note };
  }

  const player = tied[0].player;
  // A price that no longer matches means either the price moved since you
  // bought, or this is the wrong player. Worth surfacing either way.
  const priceDiffers = entry.price != null && player.price !== entry.price;
  return { status: 'resolved', entry, player, score: tied[0].score, note, priceDiffers };
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

  // Purchase prices come from the squad file where recorded, since that is what
  // was actually paid; the live price only says what the player costs today.
  const purchasePrices = {};
  for (const r of resolved) {
    if (r.entry.price != null) purchasePrices[r.player.id] = r.entry.price;
  }

  return {
    resolved, ambiguous, missing, notes, purchasePrices,
    priceMismatches: resolved.filter((r) => r.priceDiffers),
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
    const price = r.priceDiffers
      ? `, paid £${(r.entry.price / 10).toFixed(1)}m, now £${(r.player.price / 10).toFixed(1)}m`
      : '';
    lines.push(`✓ ${r.entry.name} → ${r.player.label}, ${POSITIONS[r.player.position].short}${price}`);
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

/**
 * Parse team news pasted from wherever you read it, one player per line:
 *
 *   Haaland out            → will not play
 *   Tzolis doubt 25        → 25% chance of playing
 *   Mbeumo bench           → expected off the bench
 *   Gabriel start          → expected to start
 *   Groß 60                → expected to play 60 minutes
 *
 * Blank lines and lines starting with # are ignored. The separator between the
 * name and the verdict may be a colon, a dash or just a space.
 */
export function parseTeamNews(text) {
  const entries = [];
  const problems = [];

  for (const raw of String(text).split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    const match = line.match(/^(.+?)\s*[:–—-]?\s*(out|doubt|bench|start|starting|benched|\d+%?)\s*(\d+)?%?\s*$/i);
    if (!match) { problems.push(`Could not read: "${line}"`); continue; }

    const [, name, verdictRaw, numberRaw] = match;
    const verdict = verdictRaw.toLowerCase();
    const entry = { name: name.trim(), source: line };

    if (verdict === 'out') {
      entry.availability = 0;
    } else if (verdict === 'doubt') {
      entry.availability = numberRaw != null ? clampUnit(Number(numberRaw) / 100) : 0.5;
    } else if (verdict === 'bench' || verdict === 'benched') {
      entry.minutes = 20;
    } else if (verdict === 'start' || verdict === 'starting') {
      entry.minutes = 85;
    } else {
      // A bare number is minutes, unless it was written as a percentage.
      const value = Number(verdict.replace('%', ''));
      if (!Number.isFinite(value)) { problems.push(`Could not read: "${line}"`); continue; }
      if (verdict.endsWith('%')) entry.availability = clampUnit(value / 100);
      else entry.minutes = Math.max(0, Math.min(90, value));
    }

    entries.push(entry);
  }

  return { entries, problems };
}

const clampUnit = (v) => Math.max(0, Math.min(1, v));

/**
 * Match parsed team news against a specific set of players (normally your
 * squad plus shortlist), so a surname only has to be unique among those.
 */
export function applyTeamNews(players, entries) {
  const applied = [];
  const unmatched = [];

  for (const entry of entries) {
    const ranked = players
      .map((player) => ({ player, score: matchScore(player, entry.name) }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score);

    if (ranked.length === 0) { unmatched.push({ ...entry, reason: 'no match' }); continue; }
    if (ranked.length > 1 && ranked[0].score === ranked[1].score) {
      unmatched.push({ ...entry, reason: `ambiguous: ${ranked.slice(0, 3).map((x) => x.player.label).join(' / ')}` });
      continue;
    }

    const override = {};
    if (entry.minutes != null) override.minutes = entry.minutes;
    if (entry.availability != null) override.availability = entry.availability;
    applied.push({ player: ranked[0].player, override, source: entry.source });
  }

  return { applied, unmatched };
}
