/**
 * Persistence and data loading.
 *
 * Squad state lives in this browser's localStorage - nothing is sent anywhere -
 * and can be exported to JSON to move between machines.
 */

import { emptyState, STATE_VERSION } from './squad.js';
import { loadSnapshot } from './snapshot.js';

const STORAGE_KEY = 'fpl-squad-manager:v1';
const HISTORY_KEY = 'fpl-squad-manager:v1:history';

/** How many steps back you can go. Deep enough for a bad session, not endless. */
export const HISTORY_LIMIT = 20;

export function saveState(state) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch (err) {
    console.warn('Could not save state', err);
    return false;
  }
}

export function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (parsed.version !== STATE_VERSION) return migrate(parsed);
    return parsed;
  } catch (err) {
    console.warn('Could not read saved state', err);
    return null;
  }
}

function migrate(old) {
  // Only one state version exists so far; keep the picks and start fresh around them.
  return { ...emptyState(old.gameweek ?? 1), ...old, version: STATE_VERSION };
}

export function clearState() {
  localStorage.removeItem(STORAGE_KEY);
  localStorage.removeItem(HISTORY_KEY);
}

/**
 * The undo stack, kept beside the squad so it survives closing the tab.
 *
 * Each entry is a whole past state, which is the only version that is always
 * right: reversing an action by re-deriving it would have to know how every
 * action works, and would get a price change or a chip declaration wrong.
 */
export function loadHistory() {
  try {
    const raw = localStorage.getItem(HISTORY_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    console.warn('Could not read the undo history', err);
    return [];
  }
}

/**
 * Store the stack, shedding the oldest entries if the browser refuses the size.
 * Losing the far end of the history is a far better failure than losing the
 * squad, which shares the same quota.
 */
export function saveHistory(entries) {
  let keep = entries.slice(-HISTORY_LIMIT);
  while (keep.length) {
    try {
      localStorage.setItem(HISTORY_KEY, JSON.stringify(keep));
      return keep;
    } catch (err) {
      keep = keep.slice(1);
    }
  }
  try { localStorage.removeItem(HISTORY_KEY); } catch { /* nothing more to do */ }
  return [];
}

/**
 * Load a data snapshot. Live data first (works if the API ever allows it from
 * a browser), then the file written by tools/refresh_fpl_data.py, then the
 * fictional demo set so the app always has something to show.
 */
export async function loadBestSnapshot() {
  const attempts = [
    { source: 'live', load: fetchLive },
    { source: 'snapshot', load: () => fetchJson('data/snapshot.json') },
    { source: 'demo', load: () => fetchJson('data/demo-snapshot.json') },
  ];
  const problems = [];
  for (const attempt of attempts) {
    try {
      const raw = await attempt.load();
      return { snapshot: loadSnapshot(raw), source: attempt.source, raw, problems };
    } catch (err) {
      problems.push(`${attempt.source}: ${err.message}`);
    }
  }
  throw new Error(`No data available.\n${problems.join('\n')}`);
}

async function fetchLive() {
  const [bootstrap, fixtures] = await Promise.all([
    fetchJson('https://fantasy.premierleague.com/api/bootstrap-static/'),
    fetchJson('https://fantasy.premierleague.com/api/fixtures/'),
  ]);
  return { ...bootstrap, fixtures, generated_at: new Date().toISOString() };
}

async function fetchJson(url) {
  const response = await fetch(url, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  return response.json();
}

/** Read a snapshot the manager has dropped into the file picker. */
export function readSnapshotFile(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const raw = JSON.parse(reader.result);
        resolve({ snapshot: loadSnapshot(raw), raw });
      } catch (err) {
        reject(new Error(`That file is not a valid FPL snapshot: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}

export function exportState(state) {
  const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `fpl-squad-gw${state.gameweek}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

export function importState(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!Array.isArray(parsed.picks)) throw new Error('missing picks');
        resolve(parsed);
      } catch (err) {
        reject(new Error(`That is not a squad export: ${err.message}`));
      }
    };
    reader.onerror = () => reject(new Error('Could not read that file.'));
    reader.readAsText(file);
  });
}
