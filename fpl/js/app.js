/**
 * FPL Squad Manager - UI and wiring.
 *
 * Four jobs, in the order a gameweek needs them:
 *   1. optimise the starting XI, bench order and armbands
 *   2. plan transfers from a shortlist the manager supplies
 *   3. record the transfers actually made and keep budget/free transfers honest
 *   4. take a declared chip as input - never suggest one
 */

import {
  GKP, DEF, MID, FWD, POSITIONS, BUDGET, MAX_FREE_TRANSFERS, CHIPS,
  SQUAD_SIZE, money, chipHalf,
} from './rules.js';
import { loadBestSnapshot, loadState, saveState, clearState, readSnapshotFile, exportState, importState } from './store.js';
import {
  emptyState, initialSquad, validateSquad, applyTransfers, declareChip,
  advanceGameweek, squadValue, squadPlayers, sellValue,
} from './squad.js';
import { projectSquad, teamGamesPlayed, startProbability, recentRole } from './xp.js';
import { optimiseLineup, lineupDelta } from './lineup.js';
import { planTransfers, describe, PLANNER_DEFAULTS } from './transfers.js';
import { resolveSquad, resolveSelections, describeResolution, parseTeamNews, applyTeamNews } from './roster.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const app = {
  snapshot: null,
  source: null,
  state: null,
  builder: null,      // player ids while building a squad
  targets: [],        // shortlisted transfer targets
  lineup: null,
  planResult: null,
  pendingTransfers: [],
  recordedSelections: null,   // XI/armbands from a loaded squad file
  purchasePrices: null,       // what was actually paid, from a loaded squad file
};

// ── Boot ───────────────────────────────────────────────────────────────────

init().catch((err) => {
  banner(`Could not start: ${err.message}`, true);
  console.error(err);
});

async function init() {
  const loaded = await loadBestSnapshot();
  app.snapshot = loaded.snapshot;
  app.source = loaded.source;

  app.state = loadState() ?? emptyState(app.snapshot.nextEvent ?? 1);
  if (!loadState()) app.state.gameweek = app.snapshot.nextEvent ?? 1;

  describeDataSource(loaded);
  warnIfSquadLooksWrong();
  wireTabs();
  wireSquadTab();
  wireLineupTab();
  wireTransfersTab();
  wireManageTab();
  renderAll();
}

/**
 * A squad is stored as player ids, which only mean anything against the
 * snapshot they were chosen from. Loading a different one - last season's, or
 * the demo set - silently remaps every pick to a different player. An illegal
 * shape is the tell-tale, so check for it and say so loudly.
 */
function warnIfSquadLooksWrong() {
  if (!hasSquad()) return;
  const check = validateSquad(app.state.picks.map((p) => p.playerId), app.snapshot);
  if (check.valid) return;
  banner(`Your saved squad does not fit this data: ${check.errors.join(' ')} `
    + 'This usually means the snapshot loaded is not the one the squad was built from. '
    + 'Load the right snapshot, or rebuild the squad.', true);
}

function describeDataSource({ source, raw }) {
  const when = raw.generated_at ? new Date(raw.generated_at).toLocaleString() : 'unknown time';
  const messages = {
    live: `Live FPL data, fetched just now.`,
    snapshot: `Snapshot data from ${when}. Re-run tools/refresh_fpl_data.py to update it.`,
    demo: `Demo data — these clubs and players are invented. Run "python3 tools/refresh_fpl_data.py" to load the real 2026/27 game.`,
  };
  $('#data-status').textContent = messages[source];
  if (source !== 'live') banner(messages[source], source === 'demo');
}

// ── Shared rendering ───────────────────────────────────────────────────────

function renderAll() {
  saveState(app.state);
  renderMeta();
  renderSquadTab();
  renderLineupTab();
  renderTransfersTab();
  renderManageTab();
}

function hasSquad() { return app.state.picks.length === SQUAD_SIZE; }

function renderMeta() {
  const { state, snapshot } = app;
  $('#meta-gameweek').textContent = state.gameweek;
  $('#meta-transfers').textContent = state.freeTransfers >= MAX_FREE_TRANSFERS
    ? `${state.freeTransfers} (max)` : state.freeTransfers;
  $('#meta-chip').textContent = CHIPS[state.activeChip]?.name ?? 'No chip';
  if (hasSquad()) {
    const value = squadValue(state, snapshot);
    $('#meta-value').textContent = money(value.total);
    $('#meta-bank').textContent = money(value.bank);
  } else {
    $('#meta-value').textContent = '—';
    $('#meta-bank').textContent = money(state.bank || BUDGET);
  }
}

/** Projections for a set of players across the horizon starting this gameweek. */
function project(players, horizon = 6) {
  const gameweeks = app.snapshot.horizon(app.state.gameweek, horizon);
  return {
    gameweeks,
    projections: projectSquad(app.snapshot, players, gameweeks, {
      overrides: app.state.overrides,
      teamGamesMap: teamGamesPlayed(app.snapshot),
    }),
  };
}

function fixtureStrip(teamId, gameweeks) {
  const strip = document.createElement('span');
  strip.className = 'fdr-strip';
  for (const gw of gameweeks) {
    const fixtures = app.snapshot.teamFixtures(teamId, gw);
    if (fixtures.length === 0) {
      strip.append(cell('fdr fdr-blank', '—', `Gameweek ${gw}: blank`));
      continue;
    }
    for (const f of fixtures) {
      const opponent = app.snapshot.team(f.opponent)?.short ?? '?';
      strip.append(cell(`fdr fdr-${Math.round(f.difficulty)}`,
        f.home ? opponent.toUpperCase() : opponent.toLowerCase(),
        `Gameweek ${gw}: ${f.home ? 'home' : 'away'} to ${opponent}, difficulty ${f.difficulty}`));
    }
  }
  return strip;

  function cell(className, text, title) {
    const s = document.createElement('span');
    s.className = className; s.textContent = text; s.title = title;
    return s;
  }
}

function statusLabel(player) {
  const availability = app.snapshot.availability(player);
  if (availability >= 1) return { text: 'Fit', className: '' };
  if (availability <= 0) return { text: player.status === 's' ? 'Suspended' : 'Out', className: 'bad' };
  return { text: `${Math.round(availability * 100)}% doubt`, className: 'warn' };
}

function banner(message, isError = false) {
  const el = $('#databanner');
  el.textContent = message;
  el.className = `banner${isError ? ' error' : ''}`;
  el.hidden = false;
}

let toastTimer = null;
function toast(message, kind = '') {
  const el = $('#toast');
  el.textContent = message;
  el.className = `toast ${kind}`;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 5200);
}

function wireTabs() {
  $$('.tab').forEach((tab) => tab.addEventListener('click', () => {
    $$('.tab').forEach((t) => t.setAttribute('aria-selected', String(t === tab)));
    $$('.panel').forEach((p) => { p.hidden = p.id !== `panel-${tab.dataset.tab}`; });
  }));
}

/**
 * Player search that writes buttons into `results` and calls `onPick`.
 * Used by both the squad builder and the transfer shortlist.
 */
function attachSearch({ input, positionSelect, results, onPick, exclude = () => false, label, pool = null }) {
  const run = () => {
    const query = input.value.trim();
    results.replaceChildren();
    const position = positionSelect.value ? Number(positionSelect.value) : null;

    // A restricted pool (the squad) is short enough to list without a query.
    const source = pool
      ? pool().filter((p) => (position ? p.position === position : true)
          && (query.length === 0 || app.snapshot.matches(p, query.toLowerCase())))
      : (query.length < 2 ? [] : app.snapshot.search(query, { position, limit: 30 }));
    const found = source.filter((p) => !exclude(p));

    for (const player of found.slice(0, 12)) {
      const button = document.createElement('button');
      button.className = 'result';
      button.type = 'button';

      const who = document.createElement('span');
      who.className = 'who';
      who.innerHTML = `<span>${escapeHtml(player.name)}</span>`;
      const sub = document.createElement('small');
      sub.textContent = `${POSITIONS[player.position].short} · ${app.snapshot.team(player.teamId)?.short ?? ''}`;
      who.append(sub);

      button.append(who, span(money(player.price)), span(`${player.totalPoints} pts`),
        span(label ? label(player) : ''));
      button.addEventListener('click', () => { onPick(player); input.value = ''; results.replaceChildren(); });
      results.append(button);
    }
  };
  input.addEventListener('input', run);
  positionSelect.addEventListener('change', run);

  function span(text) { const s = document.createElement('span'); s.textContent = text; return s; }
}

const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ── Squad tab ──────────────────────────────────────────────────────────────

function wireSquadTab() {
  attachSearch({
    input: $('#builder-search'),
    positionSelect: $('#builder-position'),
    results: $('#builder-results'),
    exclude: (p) => app.builder?.includes(p.id),
    onPick: (player) => { app.builder.push(player.id); renderBuilder(); },
  });

  $('#builder-confirm').addEventListener('click', confirmSquad);
  $('#builder-load-recorded').addEventListener('click', () => loadRecordedSquad('data/squad-2026-27.json'));
  $('#builder-squad-file').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    try {
      applyResolution(JSON.parse(await file.text()));
    } catch (err) {
      toast(`Could not read that squad file: ${err.message}`, 'error');
    }
  });
  $('#builder-clear').addEventListener('click', () => {
    app.builder = [];
    app.recordedSelections = null;
    app.purchasePrices = null;
    $('#builder-resolution').replaceChildren();
    renderBuilder();
  });
  $('#squad-edit').addEventListener('click', () => {
    app.builder = app.state.picks.map((p) => p.playerId);
    renderSquadTab();
  });
  $('#chip-select').addEventListener('change', (e) => {
    try {
      app.state = declareChip(app.state, e.target.value, app.snapshot);
      const name = CHIPS[e.target.value].name;
      toast(e.target.value === 'none' ? 'Chip cleared.' : `${name} recorded for GW${app.state.gameweek}.`, 'good');
    } catch (err) {
      toast(err.message, 'error');
    }
    renderAll();
  });
}

function renderSquadTab() {
  // With no squad yet the builder is the only sensible thing to show.
  if (!hasSquad() && app.builder === null) app.builder = [];
  const building = app.builder !== null;

  $('#squad-empty').hidden = hasSquad();
  $('#squad-builder').hidden = !building;
  $('#squad-view').hidden = building || !hasSquad();

  if (building) { renderBuilder(); return; }

  renderChipSelect();

  const players = squadPlayers(app.state, app.snapshot);
  const { gameweeks, projections } = project(players, 6);
  const teamGames = teamGamesPlayed(app.snapshot);
  const body = $('#squad-table tbody');
  body.replaceChildren();

  const ordered = [...players].sort((a, b) => a.position - b.position
    || (projections.get(b.id).byGameweek.get(gameweeks[0]) ?? 0) - (projections.get(a.id).byGameweek.get(gameweeks[0]) ?? 0));

  for (const player of ordered) {
    const projection = projections.get(player.id);
    const status = statusLabel(player);
    const row = document.createElement('tr');

    const pStart = startProbability(app.snapshot, player, {
      override: app.state.overrides[player.id],
      teamGames: teamGames.get(player.teamId),
    });

    row.append(
      td(player.name),
      td(POSITIONS[player.position].short),
      td(player.team?.short ?? ''),
      td(money(player.price), 'num'),
      td(money(player.sellPrice), 'num'),
      tdNode(fixtureStrip(player.teamId, gameweeks)),
      tdNode(startCell(pStart, player)),
      td((projection.byGameweek.get(gameweeks[0]) ?? 0).toFixed(1), 'num'),
      td(projection.total.toFixed(1), 'num'),
      tdNode(statusCell(status, player)),
    );
    body.append(row);
  }
}

/** Start probability, with what it was inferred from. */
function startCell(probability, player) {
  const span = document.createElement('span');
  span.textContent = `${Math.round(probability * 100)}%`;
  const role = recentRole(player);
  span.title = role
    ? `From the last ${role.matches} matches: started about ${Math.round(role.startProbability * 100)}% of them.`
    : 'No per-match history in this snapshot — estimated from season minutes. '
      + 'Re-run the refresh script to pull match history.';
  if (probability < 0.6) span.className = 'news';
  return span;
}

/** Availability plus whatever FPL's own injury feed says. */
function statusCell(status, player) {
  const wrap = document.createElement('span');
  wrap.append(pill(status.text, status.className));
  if (player.news) {
    const news = document.createElement('div');
    news.className = 'news';
    news.textContent = player.news;
    wrap.append(news);
  }
  if ((app.state.protectedIds ?? []).includes(player.id)) {
    wrap.append(pill('protected', 'ok'));
  }
  const override = app.state.overrides[player.id];
  if (override && Object.keys(override).length) {
    const flag = document.createElement('div');
    flag.className = 'small muted';
    flag.textContent = 'manually adjusted';
    wrap.append(flag);
  }
  return wrap;
}

function renderChipSelect() {
  const select = $('#chip-select');
  const half = chipHalf(app.state.gameweek);
  const used = new Set(app.state.chipsUsed[half]);
  select.replaceChildren();
  for (const chip of Object.values(CHIPS)) {
    const option = document.createElement('option');
    option.value = chip.id;
    const isUsed = used.has(chip.id) && app.state.activeChip !== chip.id;
    option.textContent = chip.id === 'none' ? 'No chip' : `${chip.name}${isUsed ? ' (used)' : ''}`;
    option.disabled = isUsed;
    option.selected = app.state.activeChip === chip.id;
    select.append(option);
  }
  const notes = {
    wildcard: 'Wildcard: transfers are free and permanent, and your banked free transfers are kept.',
    freehit: 'Free Hit: this squad counts for one gameweek only, then reverts when you advance.',
    bboost: 'Bench Boost: all 15 players score, so bench projections are added to the total.',
    '3xc': 'Triple Captain: the captain scores treble this gameweek.',
    none: '',
  };
  $('#chip-note').textContent = notes[app.state.activeChip] ?? '';
}

function renderBuilder() {
  const ids = app.builder ?? [];
  const counts = { [GKP]: 0, [DEF]: 0, [MID]: 0, [FWD]: 0 };

  // The £100.0m budget is spent at the price you paid. When a recorded squad is
  // being imported that is the price in the file, not today's price - a squad
  // whose players have since risen is not retrospectively over budget.
  let spend = 0;
  let market = 0;
  for (const id of ids) {
    const player = app.snapshot.player(id);
    counts[player.position]++;
    spend += app.purchasePrices?.[id] ?? player.price;
    market += player.price;
  }

  const pills = $('#builder-counts');
  pills.replaceChildren();
  for (const meta of Object.values(POSITIONS)) {
    const complete = counts[meta.id] === meta.squad;
    pills.append(pill(`${meta.short} ${counts[meta.id]}/${meta.squad}`,
      complete ? 'ok' : counts[meta.id] > meta.squad ? 'bad' : ''));
  }

  const remaining = BUDGET - spend;
  const spent = market === spend ? `Spent ${money(spend)}`
    : `Paid ${money(spend)}, now worth ${money(market)}`;
  $('#builder-budget').textContent = `${spent} · ${remaining < 0 ? 'over by ' + money(-remaining) : money(remaining) + ' left'}`;
  $('#builder-budget').style.color = remaining < 0 ? 'var(--bad)' : '';

  const selected = $('#builder-selected');
  selected.replaceChildren();
  for (const id of ids) {
    const player = app.snapshot.player(id);
    const chip = document.createElement('span');
    chip.className = 'chip';
    const paid = app.purchasePrices?.[id];
    const priceText = paid != null && paid !== player.price
      ? `${money(paid)} → ${money(player.price)}` : money(player.price);
    chip.textContent = `${player.name} (${POSITIONS[player.position].short}, ${app.snapshot.team(player.teamId)?.short}, ${priceText})`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.title = `Remove ${player.name}`;
    remove.addEventListener('click', () => {
      app.builder = app.builder.filter((x) => x !== id);
      renderBuilder();
    });
    chip.append(remove);
    selected.append(chip);
  }

  const validation = validateSquad(ids, app.snapshot);
  const errors = [...validation.errors];
  if (remaining < 0) errors.push(`Over budget by ${money(-remaining)}.`);
  $('#builder-errors').textContent = ids.length === SQUAD_SIZE ? errors.join(' ') : '';
  $('#builder-confirm').disabled = errors.length > 0 || ids.length !== SQUAD_SIZE;
}

/**
 * Load a squad recorded by name and resolve it against the current snapshot.
 * The result fills the builder rather than committing, so prices, budget and
 * legality are all visible before anything is saved.
 */
async function loadRecordedSquad(url) {
  try {
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    applyResolution(await response.json());
  } catch (err) {
    toast(`Could not load ${url}: ${err.message}`, 'error');
  }
}

function applyResolution(squadFile) {
  const resolution = resolveSquad(app.snapshot, squadFile);
  app.builder = resolution.playerIds;
  app.recordedSelections = resolution.ok ? resolveSelections(resolution, squadFile) : null;
  app.purchasePrices = resolution.purchasePrices;

  const box = $('#builder-resolution');
  box.replaceChildren();

  const heading = document.createElement('p');
  heading.className = 'small';
  heading.textContent = resolution.ok
    ? `All ${resolution.resolved.length} players matched. Check the prices, then confirm.`
    : `Matched ${resolution.resolved.length} of ${squadFile.picks.length}. `
      + 'Unmatched entries are listed below — add those players by hand.';
  box.append(heading);

  const list = document.createElement('pre');
  list.className = 'hint';
  list.textContent = describeResolution(app.snapshot, resolution).join('\n');
  box.append(list);

  for (const message of resolution.notes) box.append(note(message));
  if (resolution.priceMismatches?.length) {
    box.append(note(`${resolution.priceMismatches.length} player(s) cost something different now `
      + 'than what is recorded. Purchase prices come from the squad file, which is right if the '
      + 'price simply moved — but check the match is the player you meant.'));
  }
  if (app.source === 'demo') {
    box.append(note('This is the demo dataset, so real player names will not match. '
      + 'Run tools/refresh_fpl_data.py first.'));
  }
  renderBuilder();
}

function confirmSquad() {
  try {
    const fresh = app.state.picks.length ? { ...app.state, picks: [], bank: 0 } : app.state;
    app.state = initialSquad(fresh, app.builder, app.snapshot,
      { purchasePrices: app.purchasePrices ?? {} });
    if (app.recordedSelections) {
      app.state = {
        ...app.state,
        savedXi: app.recordedSelections.startingXi,
        savedCaptain: app.recordedSelections.captain,
        savedVice: app.recordedSelections.viceCaptain,
      };
    }
    app.builder = null;
    app.recordedSelections = null;
    app.purchasePrices = null;
    $('#builder-resolution').replaceChildren();
    toast('Squad saved.', 'good');
    renderAll();
  } catch (err) {
    $('#builder-errors').textContent = err.message;
  }
}

// ── Lineup tab ─────────────────────────────────────────────────────────────

function wireLineupTab() {
  $('#lineup-run').addEventListener('click', () => { runLineup(); });
}

function renderLineupTab() {
  if (app.lineup) runLineup();
}

function runLineup() {
  if (!hasSquad()) { toast('Add your 15 players first.', 'error'); return; }

  const players = squadPlayers(app.state, app.snapshot);
  const gameweek = app.state.gameweek;
  const { projections } = project(players, 6);
  const chip = app.state.activeChip;

  const priced = players.map((p) => ({
    ...p,
    points: projections.get(p.id).byGameweek.get(gameweek) ?? 0,
    startProbability: startProbability(app.snapshot, p, { override: app.state.overrides[p.id] }),
  }));
  const lineup = optimiseLineup(priced, chip);
  app.lineup = lineup;

  $('#lineup-summary').replaceChildren(
    stat('Formation', lineup.formation.name),
    stat('Projected total', `${lineup.total.toFixed(1)} pts`),
    stat('Starting XI', `${lineup.startingPoints.toFixed(1)} pts`),
    stat(CHIPS[chip]?.benchCounts ? 'Bench (counting)' : 'Bench (reserve)', `${lineup.benchPoints.toFixed(1)} pts`),
    stat('Armband', `+${lineup.captainBonus.toFixed(1)} pts`),
  );

  // Pitch: one row per position line.
  const pitch = $('#pitch');
  pitch.replaceChildren();
  for (const position of [GKP, DEF, MID, FWD]) {
    const row = document.createElement('div');
    row.className = 'pitch-row';
    for (const player of lineup.xi.filter((p) => p.position === position)) {
      row.append(playerCard(player, lineup));
    }
    if (row.children.length) pitch.append(row);
  }

  const bench = $('#bench');
  bench.replaceChildren(label('Bench'));
  lineup.bench.forEach((player, i) => {
    const card = playerCard(player, lineup);
    const order = document.createElement('span');
    order.className = 'pts';
    order.textContent = player.position === GKP ? 'GK' : `${i}.`;
    card.prepend(order);
    bench.append(card);
  });

  renderLineupChanges(lineup);

  const vice = lineup.viceCaptain;
  $('#armband-note').innerHTML = `<p class="small muted">Captain <strong>${escapeHtml(lineup.captain.label ?? lineup.captain.name)}</strong>
    (${lineup.captain.points.toFixed(1)} projected, doubled${chip === '3xc' ? ' and tripled by the chip' : ''}).
    Vice-captain <strong>${escapeHtml(vice.label ?? vice.name)}</strong> — he only scores if the captain does not play at all,
    so the pick favours the safer starter when projections are close.</p>`;

  const body = $('#lineup-table tbody');
  body.replaceChildren();
  const role = new Map(lineup.xi.map((p) => [p.id, 'Start']));
  lineup.bench.forEach((p, i) => role.set(p.id, p.position === GKP ? 'Bench (GK)' : `Bench ${i}`));
  role.set(lineup.captain.id, 'Captain');
  role.set(vice.id, 'Vice-captain');

  const detailByPlayer = new Map(players.map((p) => [p.id, projections.get(p.id).detail.get(gameweek)]));
  for (const player of [...priced].sort((a, b) => b.points - a.points)) {
    const detail = detailByPlayer.get(player.id);
    body.append(rowOf([
      td(player.label ?? player.name), td(POSITIONS[player.position].short), td(role.get(player.id) ?? ''),
      td(fixtureText(detail)), td(player.points.toFixed(1), 'num'), whyCell(detail, player),
    ]));
  }
}

/** What the optimiser would change about the XI the manager currently has saved. */
function renderLineupChanges(lineup) {
  const box = $('#lineup-changes');
  box.replaceChildren();
  if (!app.state.savedXi?.length) {
    box.append(note('No current XI recorded, so this is shown as a fresh selection. '
      + 'Loading a squad file with a starting XI lets the app show you only what to change.'));
    return;
  }

  const delta = lineupDelta(app.state.savedXi, lineup);
  const label = (p) => `${p.label ?? p.name} (${POSITIONS[p.position].short}, ${p.points.toFixed(1)})`;

  if (delta.in.length === 0) {
    box.append(note('Your current XI is already the optimal one — no changes needed.'));
  } else {
    const paragraph = document.createElement('p');
    paragraph.className = 'small';
    paragraph.innerHTML = `<strong>Change ${delta.in.length}:</strong> bring in `
      + `${delta.in.map(label).map(escapeHtml).join(', ')} · bench `
      + `${delta.out.map(label).map(escapeHtml).join(', ')}.`;
    box.append(paragraph);
  }

  const savedCaptain = app.state.savedCaptain;
  if (savedCaptain && savedCaptain !== lineup.captain.id) {
    const swap = app.snapshot.player(savedCaptain);
    box.append(note(`Captaincy: the model prefers ${lineup.captain.label} `
      + `(${lineup.captain.points.toFixed(1)}) over your current pick ${swap?.label ?? savedCaptain}.`));
  }
}

function playerCard(player, lineup) {
  const card = document.createElement('div');
  const isCaptain = player.id === lineup.captain?.id;
  const isVice = player.id === lineup.viceCaptain?.id;
  card.className = `player-card${isCaptain ? ' captain' : ''}${isVice ? ' vice' : ''}` +
    (app.snapshot.availability(player) < 1 ? ' flagged' : '');
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = player.name;
  if (isCaptain || isVice) {
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = isCaptain ? 'C' : 'V';
    name.append(badge);
  }
  const pts = document.createElement('span');
  pts.className = 'pts';
  pts.textContent = `${player.points.toFixed(1)} · ${app.snapshot.team(player.teamId)?.short ?? ''}`;
  card.append(name, pts);
  card.title = player.news || '';
  return card;
}

function fixtureText(detail) {
  if (!detail || detail.blank) return 'Blank';
  return detail.fixtures.map((f) => {
    const opponent = app.snapshot.team(f.opponent)?.short ?? '?';
    return `${f.home ? opponent.toUpperCase() : opponent.toLowerCase()} (${f.difficulty})`;
  }).join(' + ');
}

/** Every component of a projection, in the order they are worth explaining. */
const COMPONENT_NAMES = {
  appearance: 'minutes played',
  goals: 'goals',
  assists: 'assists',
  cleanSheet: 'clean sheet',
  defensiveContribution: 'defensive contribution',
  saves: 'saves',
  penaltySaves: 'penalty saves',
  bonus: 'bonus',
  goalsConceded: 'goals conceded',
  cards: 'cards',
  penaltiesMissed: 'penalty misses',
  ownGoals: 'own goals',
};

/**
 * The full arithmetic behind a projection, summing to the number displayed.
 * Every scoring rule is listed, however small, and the blend with FPL's own
 * projection is shown as its own line rather than quietly shifting the total.
 */
function breakdown(detail) {
  const parts = {};
  for (const fixture of detail.fixtures ?? []) {
    for (const [key, value] of Object.entries(fixture.detail.parts ?? {})) {
      parts[key] = (parts[key] ?? 0) + value;
    }
  }
  const rows = Object.entries(parts)
    .filter(([, v]) => Math.abs(v) >= 0.005)
    .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]))
    .map(([key, value]) => ({ label: COMPONENT_NAMES[key] ?? key, value }));

  return { rows, modelTotal: detail.modelTotal ?? 0, blend: detail.blend, total: detail.total ?? 0 };
}

/** One-line summary: the biggest few components, for the table cell itself. */
function explain(detail, player) {
  if (!detail || detail.blank) return 'No fixture this gameweek.';
  if (app.snapshot.availability(player) <= 0) {
    return `Not expected to play: ${player.news || 'unavailable'}.`;
  }
  const { rows } = breakdown(detail);
  const shown = rows.filter((r) => Math.abs(r.value) >= 0.15).slice(0, 3);
  const hidden = rows.length - shown.length;
  const text = shown.map((r) => `${r.label} ${r.value > 0 ? '+' : ''}${r.value.toFixed(1)}`).join(', ');
  return hidden > 0 ? `${text} +${hidden} more` : text;
}

/** An expandable cell: summary line, with the full reconciling sum inside. */
function whyCell(detail, player) {
  const cell = document.createElement('td');
  cell.className = 'wrap';

  const summary = explain(detail, player);
  if (!detail || detail.blank || app.snapshot.availability(player) <= 0) {
    cell.textContent = summary;
    return cell;
  }

  const { rows, modelTotal, blend, total } = breakdown(detail);
  const details = document.createElement('details');
  details.className = 'why';
  const head = document.createElement('summary');
  head.textContent = summary;
  details.append(head);

  // Plain rows rather than a nested table: a table inside a table cell makes
  // every "tbody tr" selector on the page ambiguous.
  const list = document.createElement('div');
  list.className = 'why-list';
  for (const row of rows) list.append(whyRow(row.label, row.value));

  if (blend) {
    list.append(whyRow('model total', modelTotal, 'subtotal'));
    list.append(whyRow(`FPL's own projection (${Math.round(blend.weight * 100)}% weight)`,
      blend.epNext, 'blend'));
  }
  list.append(whyRow('projected', total, 'total'));

  details.append(list);
  cell.append(details);

  const availability = app.snapshot.availability(player);
  if (availability < 1) {
    cell.append(note(`Scaled to a ${Math.round(availability * 100)}% chance of playing.`));
  }
  return cell;
}

function whyRow(label, value, kind = '') {
  const row = document.createElement('div');
  row.className = `why-row${kind ? ` why-${kind}` : ''}`;
  const name = document.createElement('span');
  name.textContent = label;
  const amount = document.createElement('span');
  amount.className = 'why-value';
  const signed = kind === '' && value > 0 ? '+' : '';
  amount.textContent = `${signed}${value.toFixed(2)}`;
  row.append(name, amount);
  return row;
}

// ── Transfers tab ──────────────────────────────────────────────────────────

function wireTransfersTab() {
  attachSearch({
    input: $('#target-search'),
    positionSelect: $('#target-position'),
    results: $('#target-results'),
    exclude: (p) => app.targets.includes(p.id) || app.state.picks.some((x) => x.playerId === p.id),
    onPick: (player) => { app.targets.push(player.id); renderTransfersTab(); },
  });
  attachSearch({
    input: $('#protect-search'),
    positionSelect: $('#target-position'),
    results: $('#protect-results'),
    pool: () => (hasSquad() ? squadPlayers(app.state, app.snapshot) : []),
    exclude: (p) => (app.state.protectedIds ?? []).includes(p.id),
    onPick: (player) => {
      app.state = {
        ...app.state,
        protectedIds: [...(app.state.protectedIds ?? []), player.id],
      };
      app.planResult = null;
      renderAll();
    },
  });
  $('#plan-run').addEventListener('click', runPlanner);
}

function renderTransfersTab() {
  const list = $('#target-list');
  list.replaceChildren();
  for (const id of app.targets) {
    const player = app.snapshot.player(id);
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.textContent = `${player.name} (${POSITIONS[player.position].short}, ${app.snapshot.team(player.teamId)?.short}, ${money(player.price)})`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×';
    remove.addEventListener('click', () => {
      app.targets = app.targets.filter((x) => x !== id);
      app.planResult = null;
      renderTransfersTab();
    });
    chip.append(remove);
    list.append(chip);
  }
  renderProtectedList();
  renderManualTransfer();
  if (app.planResult) renderPlans(app.planResult);
}

function renderProtectedList() {
  const list = $('#protect-list');
  list.replaceChildren();

  // Protecting someone you no longer own is meaningless, so drop them. This
  // also self-heals after a player is sold by hand, or if the state is opened
  // against a snapshot whose ids differ.
  if (hasSquad()) {
    const owned = new Set(app.state.picks.map((p) => p.playerId));
    const kept = (app.state.protectedIds ?? []).filter((id) => owned.has(id));
    if (kept.length !== (app.state.protectedIds ?? []).length) {
      app.state = { ...app.state, protectedIds: kept };
      saveState(app.state);
    }
  }

  const ids = app.state.protectedIds ?? [];
  if (ids.length === 0) {
    list.append(note('None protected — every squad player is available to the planner.'));
    return;
  }
  for (const id of ids) {
    const player = app.snapshot.player(id);
    if (!player) continue;
    const chip = document.createElement('span');
    chip.className = 'chip protected';
    chip.textContent = `${player.label} · ${POSITIONS[player.position].short}`;
    const remove = document.createElement('button');
    remove.type = 'button'; remove.textContent = '×'; remove.title = `Stop protecting ${player.name}`;
    remove.addEventListener('click', () => {
      app.state = { ...app.state, protectedIds: ids.filter((x) => x !== id) };
      app.planResult = null;
      renderAll();
    });
    chip.append(remove);
    list.append(chip);
  }
}

function runPlanner() {
  if (!hasSquad()) { toast('Add your 15 players first.', 'error'); return; }
  try {
    const result = planTransfers(app.state, app.snapshot, app.targets, {
      horizon: Number($('#opt-horizon').value),
      maxHits: Number($('#opt-hits').value),
      freeTransferValue: Number($('#opt-ftvalue').value),
      overrides: app.state.overrides,
      protectedIds: app.state.protectedIds ?? [],
    });
    app.planResult = result;
    renderPlans(result);
  } catch (err) {
    toast(err.message, 'error');
    console.error(err);
  }
}

function renderPlans(result) {
  const { recommendation } = result;
  const box = $('#plan-recommendation');
  box.className = `recommendation ${recommendation.action === 'hold' ? 'hold' : ''}`;
  box.replaceChildren();

  const heading = document.createElement('h3');
  heading.textContent = recommendation.action === 'hold' ? 'Hold' : 'Recommended';
  const text = document.createElement('p');
  text.textContent = recommendation.headline;
  box.append(heading, text);

  const context = document.createElement('p');
  context.className = 'small muted';
  const chipName = result.chip === 'none' ? 'no chip' : CHIPS[result.chip].name;
  const protectedCount = result.protectedIds?.length ?? 0;
  context.textContent = `Gameweeks ${result.gameweeks[0]}–${result.gameweeks.at(-1)} · `
    + `${result.freeTransfers} free transfer${result.freeTransfers === 1 ? '' : 's'} · ${chipName} · `
    + `${result.consideredPlans} legal combinations evaluated`
    + (protectedCount ? `, ${result.blockedPlans} ruled out by ${protectedCount} protected player${protectedCount === 1 ? '' : 's'}` : '')
    + '.';
  box.append(context);

  // Protection is a choice with a price; show the price.
  if (result.protectionCost) {
    const cost = document.createElement('p');
    cost.className = 'small';
    const names = result.protectionCost.players.map((p) => p.label).join(', ');
    cost.innerHTML = `<strong>Protection cost:</strong> keeping ${escapeHtml(names)} rules out `
      + `${escapeHtml(describe(result.protectionCost.plan))}, which would have been worth `
      + `${result.protectionCost.forgone.toFixed(1)} points more.`;
    box.append(cost);
  }

  if (recommendation.action === 'transfer') {
    const apply = document.createElement('button');
    apply.className = 'primary';
    apply.textContent = 'Apply this plan';
    apply.addEventListener('click', () => applyPlan(recommendation.plan));
    box.append(apply);
  }

  const list = $('#plan-results');
  list.replaceChildren();
  if (!result.plans.length) return;

  const title = document.createElement('h3');
  title.textContent = 'All options considered';
  title.className = 'small';
  list.append(title);

  for (const plan of result.plans) {
    const details = document.createElement('details');
    details.className = 'plan';

    const summary = document.createElement('summary');
    const move = document.createElement('span');
    move.className = 'plan-move';
    move.textContent = describe(plan);
    const gain = document.createElement('span');
    gain.className = plan.netGain >= 0 ? 'gain-pos' : 'gain-neg';
    gain.textContent = `${plan.netGain >= 0 ? '+' : ''}${plan.netGain.toFixed(1)} pts`;
    const meta = document.createElement('span');
    meta.className = 'small muted';
    meta.textContent = `${plan.transfers} transfer${plan.transfers === 1 ? '' : 's'}`
      + (plan.hits ? ` · −${plan.hits} hit` : '')
      + ` · bank ${money(plan.bankAfter)} · ${plan.freeTransfersAfter} free left`;
    summary.append(move, gain, meta);
    details.append(summary);

    const table = document.createElement('table');
    table.className = 'grid';
    table.innerHTML = '<thead><tr><th>Gameweek</th><th class="num">Projected</th><th>Formation</th><th>Captain</th></tr></thead>';
    const body = document.createElement('tbody');
    for (const week of plan.perGameweek) {
      body.append(rowOf([
        td(`GW${week.gameweek}`),
        td(week.points.toFixed(1), 'num'),
        td(week.lineup.formation.name),
        td(week.lineup.captain?.label ?? ''),
      ]));
    }
    table.append(body);

    const wrap = document.createElement('div');
    wrap.className = 'table-scroll';
    wrap.append(table);
    details.append(wrap);

    if (plan.transfers > 0) {
      const apply = document.createElement('button');
      apply.className = 'tiny';
      apply.textContent = 'Apply this plan';
      apply.addEventListener('click', () => applyPlan(plan));
      details.append(apply);
    }
    list.append(details);
  }
}

function applyPlan(plan) {
  try {
    const result = applyTransfers(app.state, {
      out: plan.transfersOut.map((p) => p.id),
      in: plan.transfersIn.map((p) => p.id),
    }, app.snapshot);
    app.state = result.state;
    app.targets = app.targets.filter((id) => !plan.transfersIn.some((p) => p.id === id));
    app.planResult = null;
    app.lineup = null;
    toast(`Applied: ${describe(plan)}${result.cost ? ` (−${result.cost} points)` : ''}.`, 'good');
    renderAll();
  } catch (err) {
    toast(err.message, 'error');
  }
}

/** Manual entry, for when the manager goes a different way to the suggestion. */
function renderManualTransfer() {
  const container = $('#manual-transfer');
  container.replaceChildren();
  if (!hasSquad()) {
    container.append(note('Add your squad first.'));
    return;
  }

  const outSelect = document.createElement('select');
  for (const player of squadPlayers(app.state, app.snapshot).sort((a, b) => a.position - b.position)) {
    const option = document.createElement('option');
    option.value = player.id;
    const guarded = (app.state.protectedIds ?? []).includes(player.id) ? ' · protected' : '';
    option.textContent = `${player.label} · ${POSITIONS[player.position].short} · sells ${money(player.sellPrice)}${guarded}`;
    outSelect.append(option);
  }

  const inSelect = document.createElement('select');
  const refreshIn = () => {
    const position = app.snapshot.player(Number(outSelect.value)).position;
    inSelect.replaceChildren();
    const owned = new Set(app.state.picks.map((p) => p.playerId));
    const options = [...app.snapshot.players.values()]
      .filter((p) => p.position === position && !owned.has(p.id))
      .sort((a, b) => b.totalPoints - a.totalPoints || b.price - a.price);
    for (const player of options) {
      const option = document.createElement('option');
      option.value = player.id;
      option.textContent = `${player.label} · ${money(player.price)}`;
      inSelect.append(option);
    }
  };
  outSelect.addEventListener('change', refreshIn);
  refreshIn();

  const add = document.createElement('button');
  add.textContent = 'Add to this gameweek';
  add.addEventListener('click', () => {
    app.pendingTransfers.push({ out: Number(outSelect.value), in: Number(inSelect.value) });
    renderManualTransfer();
  });

  container.append(
    labelled('Out', outSelect), labelled('In', inSelect), add,
  );

  if (app.pendingTransfers.length) {
    const pending = document.createElement('div');
    pending.className = 'chips';
    app.pendingTransfers.forEach((pair, i) => {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = `${app.snapshot.player(pair.out).label} → ${app.snapshot.player(pair.in).label}`;
      const remove = document.createElement('button');
      remove.type = 'button'; remove.textContent = '×';
      remove.addEventListener('click', () => {
        app.pendingTransfers.splice(i, 1);
        renderManualTransfer();
      });
      chip.append(remove);
      pending.append(chip);
    });

    const free = app.state.freeTransfers;
    const used = app.pendingTransfers.length;
    const cost = CHIPS[app.state.activeChip]?.unlimitedTransfers ? 0 : Math.max(0, used - free) * 4;
    const summary = note(`${used} transfer${used === 1 ? '' : 's'}, ${free} free — `
      + (cost ? `costs ${cost} points.` : 'no points hit.'));

    const confirm = document.createElement('button');
    confirm.className = 'primary';
    confirm.textContent = 'Confirm transfers';
    confirm.addEventListener('click', () => {
      try {
        const result = applyTransfers(app.state, {
          out: app.pendingTransfers.map((p) => p.out),
          in: app.pendingTransfers.map((p) => p.in),
        }, app.snapshot);
        app.state = result.state;
        app.pendingTransfers = [];
        app.planResult = null;
        app.lineup = null;
        toast(`Squad updated${result.cost ? ` (−${result.cost} points)` : ''}.`, 'good');
        renderAll();
      } catch (err) {
        toast(err.message, 'error');
      }
    });

    container.append(pending, summary, confirm);
  }
}

// ── Manage tab ─────────────────────────────────────────────────────────────

function wireManageTab() {
  $('#advance-gw').addEventListener('click', () => {
    app.state = advanceGameweek(app.state);
    app.lineup = null; app.planResult = null; app.pendingTransfers = [];
    toast(`Now Gameweek ${app.state.gameweek}. ${app.state.freeTransfers} free transfer(s).`, 'good');
    renderAll();
  });
  $('#apply-gw').addEventListener('click', () => {
    const gameweek = Number($('#set-gw').value);
    app.state = { ...app.state, gameweek };
    renderAll();
  });
  $('#export-state').addEventListener('click', () => exportState(app.state));
  $('#import-state').addEventListener('change', async (e) => {
    try {
      app.state = await importState(e.target.files[0]);
      toast('Squad imported.', 'good');
      renderAll();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#snapshot-file').addEventListener('change', async (e) => {
    try {
      const { snapshot, raw } = await readSnapshotFile(e.target.files[0]);
      app.snapshot = snapshot;
      app.source = raw.demo ? 'demo' : 'snapshot';
      describeDataSource({ source: app.source, raw });
      toast('Snapshot loaded.', 'good');
      renderAll();
      warnIfSquadLooksWrong();
    } catch (err) { toast(err.message, 'error'); }
  });
  $('#team-news-apply').addEventListener('click', applyTeamNewsFromBox);
  $('#team-news-clear').addEventListener('click', () => {
    app.state = { ...app.state, overrides: {} };
    app.lineup = null;
    $('#team-news-result').replaceChildren();
    toast('All manual adjustments cleared.', 'good');
    renderAll();
  });
  $('#reset-state').addEventListener('click', () => {
    if (!confirm('Delete the saved squad, transfers and chip history from this browser?')) return;
    clearState();
    app.state = emptyState(app.snapshot.nextEvent ?? 1);
    app.builder = []; app.targets = []; app.lineup = null; app.planResult = null;
    renderAll();
  });
}

/**
 * Turn pasted team news into per-player overrides. Matching is limited to the
 * squad plus the transfer shortlist, so a surname only needs to be unique
 * among the players you actually care about.
 */
function applyTeamNewsFromBox() {
  const box = $('#team-news-result');
  box.replaceChildren();

  if (!hasSquad()) { toast('Add your squad first.', 'error'); return; }
  const { entries, problems } = parseTeamNews($('#team-news').value);
  if (entries.length === 0 && problems.length === 0) return;

  const pool = [
    ...squadPlayers(app.state, app.snapshot),
    ...app.targets.map((id) => app.snapshot.player(id)).filter(Boolean),
  ];
  const { applied, unmatched } = applyTeamNews(pool, entries);

  const overrides = { ...app.state.overrides };
  for (const item of applied) {
    overrides[item.player.id] = { ...(overrides[item.player.id] ?? {}), ...item.override };
  }
  app.state = { ...app.state, overrides };
  app.lineup = null;

  const lines = applied.map((a) => {
    const parts = [];
    if (a.override.minutes != null) parts.push(`${a.override.minutes} minutes`);
    if (a.override.availability != null) parts.push(`${Math.round(a.override.availability * 100)}% to play`);
    return `✓ ${a.player.label}: ${parts.join(', ')}`;
  });
  for (const u of unmatched) lines.push(`✗ ${u.name} — ${u.reason}`);
  for (const p of problems) lines.push(`✗ ${p}`);

  const report = document.createElement('pre');
  report.className = 'hint';
  report.textContent = lines.join('\n');
  box.append(report);

  toast(`${applied.length} adjustment(s) applied.`, applied.length ? 'good' : 'error');
  renderAll();
}

function renderManageTab() {
  $('#set-gw').value = app.state.gameweek;

  const chips = $('#chips-used');
  chips.replaceChildren();
  for (const half of ['first', 'second']) {
    const range = half === 'first' ? 'GW1–19' : 'GW20–38';
    for (const chip of Object.values(CHIPS).filter((c) => c.id !== 'none')) {
      const used = app.state.chipsUsed[half].includes(chip.id);
      chips.append(pill(`${range} ${chip.name}${used ? ' — used' : ''}`, used ? 'used' : ''));
    }
  }

  renderOverrides();

  const log = $('#log');
  log.replaceChildren();
  if (!app.state.log.length) { log.append(note('Nothing recorded yet.')); return; }
  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = '<thead><tr><th>GW</th><th>Event</th><th>Detail</th></tr></thead>';
  const body = document.createElement('tbody');
  for (const entry of [...app.state.log].reverse()) {
    body.append(rowOf([td(`GW${entry.gameweek}`), td(entry.type), td(logDetail(entry), 'wrap')]));
  }
  table.append(body);
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.append(table);
  log.append(wrap);
}

function logDetail(entry) {
  const name = (id) => app.snapshot.player(id)?.label ?? `#${id}`;
  switch (entry.type) {
    case 'initial': return `Squad set, spent ${money(entry.spend)}, bank ${money(entry.bank)}.`;
    case 'transfers': return `${entry.out.map(name).join(', ')} → ${entry.in.map(name).join(', ')}`
      + `${entry.cost ? ` (−${entry.cost} pts)` : ''}, bank ${money(entry.bank)}.`;
    case 'chip': return `${CHIPS[entry.chip]?.name ?? entry.chip} played.`;
    case 'chip-cleared': return `${CHIPS[entry.chip]?.name ?? entry.chip} cancelled before the deadline.`;
    case 'advance': return entry.freeHitReverted ? 'Free Hit squad reverted.' : 'Gameweek advanced.';
    default: return '';
  }
}

function renderOverrides() {
  const container = $('#overrides');
  container.replaceChildren();
  if (!hasSquad()) { container.append(note('Add your squad first.')); return; }

  const table = document.createElement('table');
  table.className = 'grid';
  table.innerHTML = '<thead><tr><th>Player</th><th>Expected minutes</th><th>Chance of playing</th>'
    + '<th>Defensive contribution rate</th><th></th></tr></thead>';
  const body = document.createElement('tbody');

  for (const player of squadPlayers(app.state, app.snapshot).sort((a, b) => a.position - b.position)) {
    const override = app.state.overrides[player.id] ?? {};
    const row = document.createElement('tr');

    const minutes = numberInput(override.minutes, 0, 90, 5, (value) => setOverride(player.id, 'minutes', value));
    const availability = numberInput(
      override.availability == null ? null : Math.round(override.availability * 100), 0, 100, 5,
      (value) => setOverride(player.id, 'availability', value == null ? null : value / 100));
    const defcon = numberInput(
      override.defconRate == null ? null : Math.round(override.defconRate * 100), 0, 100, 5,
      (value) => setOverride(player.id, 'defconRate', value == null ? null : value / 100));

    const clear = document.createElement('button');
    clear.className = 'tiny ghost';
    clear.textContent = 'Clear';
    clear.addEventListener('click', () => {
      delete app.state.overrides[player.id];
      renderAll();
    });

    row.append(td(`${player.name} (${POSITIONS[player.position].short})`),
      tdNode(minutes), tdNode(availability), tdNode(defcon), tdNode(clear));
    body.append(row);
  }
  table.append(body);
  const wrap = document.createElement('div');
  wrap.className = 'table-scroll';
  wrap.append(table);
  container.append(wrap,
    note('Leave a field blank to use the model\'s own estimate. Defensive contribution rate is '
      + 'the chance of hitting the threshold in a full match.'));
}

function setOverride(playerId, key, value) {
  const current = { ...(app.state.overrides[playerId] ?? {}) };
  if (value == null) delete current[key]; else current[key] = value;
  app.state.overrides = { ...app.state.overrides, [playerId]: current };
  if (Object.keys(current).length === 0) delete app.state.overrides[playerId];
  saveState(app.state);
  app.lineup = null;
  renderSquadTab();
}

// ── Small DOM helpers ──────────────────────────────────────────────────────

function td(text, className = '') {
  const cell = document.createElement('td');
  cell.textContent = text;
  if (className) cell.className = className;
  return cell;
}
function tdNode(node) {
  const cell = document.createElement('td');
  cell.append(node);
  return cell;
}
function rowOf(cells) {
  const row = document.createElement('tr');
  row.append(...cells);
  return row;
}
function pill(text, className = '') {
  const span = document.createElement('span');
  span.className = `pill ${className}`.trim();
  span.textContent = text;
  return span;
}
function stat(label, value) {
  const wrap = document.createElement('div');
  wrap.className = 'stat';
  const l = document.createElement('span');
  l.className = 'stat-label'; l.textContent = label;
  const v = document.createElement('strong');
  v.textContent = value;
  wrap.append(l, v);
  return wrap;
}
function label(text) {
  const span = document.createElement('span');
  span.className = 'bench-label';
  span.textContent = text;
  return span;
}
function note(text) {
  const p = document.createElement('p');
  p.className = 'small muted';
  p.textContent = text;
  return p;
}
function labelled(text, control) {
  const wrap = document.createElement('label');
  wrap.className = 'inline';
  wrap.append(`${text} `, control);
  return wrap;
}
function numberInput(value, min, max, step, onChange) {
  const input = document.createElement('input');
  input.type = 'number';
  input.min = min; input.max = max; input.step = step;
  input.style.width = '5.5rem';
  if (value != null) input.value = value;
  input.addEventListener('change', () => {
    onChange(input.value === '' ? null : Number(input.value));
  });
  return input;
}
