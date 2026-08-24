/**
 * Predicted points published by someone else, brought in by hand.
 *
 * Tables like these are laid out as one row per player and one column per
 * gameweek. The exact wording of the headers varies, so columns are detected
 * rather than assumed, and anything that cannot be matched is reported instead
 * of being quietly dropped.
 *
 * Accepts what you get from selecting a table in a browser and copying it
 * (tab-separated), a CSV export, or a JSON array.
 */

import { matchScore, normalise } from './roster.js';

/** Header names that identify the player, the club, and everything ignorable. */
const NAME_HEADERS = ['player', 'name', 'web name', 'player name', 'full name'];
const TEAM_HEADERS = ['team', 'club', 'side'];
const POSITION_HEADERS = ['position', 'pos'];
const PRICE_HEADERS = ['price', 'cost', 'value', '£'];

/** A gameweek column: "GW12", "gw 12", "12", "Gameweek 12". */
function gameweekOf(header) {
  const cleaned = String(header).trim().toLowerCase().replace(/[^a-z0-9]/g, '');
  const match = cleaned.match(/^(?:gw|gameweek|game|week|w)?(\d{1,2})$/);
  if (!match) return null;
  const gameweek = Number(match[1]);
  return gameweek >= 1 && gameweek <= 38 ? gameweek : null;
}

const isHeader = (cell, list) => list.includes(String(cell).trim().toLowerCase());

const DELIMITERS = ['\t', '|', ','];

/**
 * Find the header row and split the table on the delimiter it uses.
 *
 * A copied page usually carries a line or two of prose above the table, so the
 * header is located by looking for the first row that names a player column and
 * at least one gameweek - rather than assuming it comes first.
 *
 * @returns {{rows:string[][], headerAt:number, delimiter:string, preamble:string[]}|null}
 */
export function parseTable(text) {
  const lines = String(text).split('\n').map((l) => l.replace(/\r$/, '')).filter((l) => l.trim());
  if (lines.length === 0) return null;

  for (let at = 0; at < Math.min(lines.length, 20); at++) {
    for (const delimiter of DELIMITERS) {
      const header = splitRow(lines[at], delimiter).map((c) => c.trim());
      if (header.length < 2) continue;
      const hasName = header.some((c) => isHeader(c, NAME_HEADERS));
      const hasGameweek = header.some((c) => gameweekOf(c) != null);
      if (!hasName || !hasGameweek) continue;

      return {
        rows: lines.slice(at).map((line) => splitRow(line, delimiter).map((cell) => cell.trim())),
        headerAt: at,
        delimiter,
        preamble: lines.slice(0, at),
      };
    }
  }
  return null;
}

/** Split one row, respecting quotes so a comma inside a name is not a break. */
function splitRow(line, delimiter) {
  if (delimiter !== ',') return line.split(delimiter);
  const cells = [];
  let current = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (quoted && line[i + 1] === '"') { current += '"'; i++; } else quoted = !quoted;
    } else if (ch === ',' && !quoted) {
      cells.push(current); current = '';
    } else current += ch;
  }
  cells.push(current);
  return cells;
}

/**
 * Turn a pasted table into per-player, per-gameweek predictions.
 * @returns {{entries:object[], gameweeks:number[], problems:string[]}}
 */
export function parsePredictedPoints(text) {
  const trimmed = String(text).trim();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) return parseJson(trimmed);

  const table = parseTable(trimmed);
  const problems = [];
  if (!table || table.rows.length < 2) {
    const firstLine = trimmed.split('\n')[0]?.slice(0, 120) ?? '';
    return { entries: [], gameweeks: [], problems: [
      'Could not find a header row naming a player column and at least one gameweek. '
      + `The text starts: ${firstLine}`] };
  }

  const { rows, preamble } = table;
  const header = rows[0];
  const nameAt = header.findIndex((c) => isHeader(c, NAME_HEADERS));
  const teamAt = header.findIndex((c) => isHeader(c, TEAM_HEADERS));
  const positionAt = header.findIndex((c) => isHeader(c, POSITION_HEADERS));
  const priceAt = header.findIndex((c) => PRICE_HEADERS.some((h) => String(c).trim().toLowerCase().includes(h)));

  // "8 GW total" and the like are summaries, not gameweeks, so they fall out
  // here: a heading only counts if it is nothing but an optional prefix and a
  // number.
  const gameweekColumns = header
    .map((cell, index) => ({ index, gameweek: gameweekOf(cell) }))
    .filter((c) => c.gameweek != null);

  const entries = [];
  for (const row of rows.slice(1)) {
    const name = row[nameAt];
    if (!name) continue;

    const points = {};
    for (const column of gameweekColumns) {
      const value = Number(String(row[column.index] ?? '').replace(/[^0-9.\-]/g, ''));
      if (Number.isFinite(value)) points[column.gameweek] = value;
    }
    if (Object.keys(points).length === 0) {
      problems.push(`No numbers read for "${name}".`);
      continue;
    }

    entries.push({
      name,
      team: teamAt === -1 ? null : row[teamAt] || null,
      position: positionAt === -1 ? null : row[positionAt] || null,
      price: priceAt === -1 ? null : row[priceAt] || null,
      points,
    });
  }

  return {
    entries,
    gameweeks: [...new Set(gameweekColumns.map((c) => c.gameweek))].sort((a, b) => a - b),
    problems,
    skippedLines: preamble.length,
  };
}

function parseJson(text) {
  try {
    const parsed = JSON.parse(text);
    const rows = Array.isArray(parsed) ? parsed : parsed.players ?? parsed.data ?? [];
    const entries = [];
    const gameweeks = new Set();
    for (const row of rows) {
      const name = row.name ?? row.player ?? row.web_name;
      if (!name) continue;
      const points = {};
      const source = row.points ?? row.predicted ?? row;
      for (const [key, value] of Object.entries(source)) {
        const gameweek = gameweekOf(key);
        if (gameweek == null) continue;
        const number = Number(value);
        if (Number.isFinite(number)) { points[gameweek] = number; gameweeks.add(gameweek); }
      }
      if (Object.keys(points).length) {
        entries.push({ name, team: row.team ?? row.club ?? null, position: row.position ?? null,
          price: row.price ?? null, points });
      }
    }
    return { entries, gameweeks: [...gameweeks].sort((a, b) => a - b), problems: [] };
  } catch (err) {
    return { entries: [], gameweeks: [], problems: [`That is not valid JSON: ${err.message}`] };
  }
}

/**
 * Match parsed rows to players in the snapshot.
 *
 * A published table covers the whole league, so matching is restricted to the
 * players actually asked about - normally the squad plus any shortlist - which
 * makes a surname enough and keeps a wrong match far less likely.
 *
 * @returns {{points:object, matched:object[], unmatched:object[], ambiguous:object[]}}
 */
export function matchPredictions(players, entries) {
  const matched = [];
  const unmatched = [];
  const ambiguous = [];
  const points = {};
  const claimed = new Set();

  for (const entry of entries) {
    const ranked = players
      .filter((p) => !claimed.has(p.id))
      .map((player) => ({ player, score: matchScore(player, entry.name) }))
      .filter((x) => x.score > 0);

    if (ranked.length === 0) { unmatched.push(entry); continue; }

    // A club column, when the table has one, separates players who share a name.
    let best = ranked.sort((a, b) => b.score - a.score);
    if (entry.team) {
      const club = normalise(entry.team);
      const sameClub = best.filter((x) => {
        const team = x.player.team ?? null;
        const short = normalise(team?.short ?? '');
        const full = normalise(team?.name ?? '');
        return short === club || full === club || full.startsWith(club) || club.startsWith(short);
      });
      if (sameClub.length) best = sameClub;
    }

    const tied = best.filter((x) => x.score === best[0].score);
    if (tied.length > 1) { ambiguous.push({ ...entry, candidates: tied.map((x) => x.player) }); continue; }

    claimed.add(best[0].player.id);
    points[best[0].player.id] = { ...entry.points };
    matched.push({ entry, player: best[0].player });
  }

  return { points, matched, unmatched, ambiguous };
}

/** Which of the wanted gameweeks a player actually has a number for. */
export function coverage(points, playerIds, gameweeks) {
  let have = 0;
  const missing = [];
  for (const id of playerIds) {
    for (const gameweek of gameweeks) {
      if (points[id]?.[gameweek] != null) have++;
      else missing.push({ playerId: id, gameweek });
    }
  }
  const wanted = playerIds.length * gameweeks.length;
  return { have, wanted, missing, complete: wanted > 0 && have === wanted };
}
