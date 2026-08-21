/**
 * Persistence and data loading.
 *
 * Squad state lives in this browser's localStorage - nothing is sent anywhere -
 * and can be exported to JSON to move between machines.
 */

import { emptyState, STATE_VERSION } from './squad.js';
import { loadSnapshot } from './snapshot.js';

const STORAGE_KEY = 'fpl-squad-manager:v1';

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
