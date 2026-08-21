/**
 * Fantasy Premier League 2026/27 rules, encoded as data.
 *
 * All money is handled in tenths of a million (the unit the FPL API uses),
 * so £5.5m is 55. Keeping money integral avoids float drift in the
 * selling-price and budget arithmetic.
 */

export const SEASON = '2026/27';

export const GKP = 1, DEF = 2, MID = 3, FWD = 4;

export const POSITIONS = {
  [GKP]: { id: GKP, short: 'GKP', name: 'Goalkeeper', squad: 2, min: 1, max: 1 },
  [DEF]: { id: DEF, short: 'DEF', name: 'Defender', squad: 5, min: 3, max: 5 },
  [MID]: { id: MID, short: 'MID', name: 'Midfielder', squad: 5, min: 2, max: 5 },
  [FWD]: { id: FWD, short: 'FWD', name: 'Forward', squad: 3, min: 1, max: 3 },
};

export const SQUAD_SIZE = 15;
export const STARTING_XI = 11;
export const BUDGET = 1000;          // £100.0m
export const MAX_PER_CLUB = 3;
export const MAX_FREE_TRANSFERS = 5;
export const TRANSFER_HIT = 4;       // points per transfer beyond the free allocation

/** Points for a goal, by position. Goalkeeper goals are worth 10 in 2026/27. */
export const GOAL_POINTS = { [GKP]: 10, [DEF]: 6, [MID]: 5, [FWD]: 4 };
export const ASSIST_POINTS = 3;
export const CLEAN_SHEET_POINTS = { [GKP]: 4, [DEF]: 4, [MID]: 1, [FWD]: 0 };
export const SAVES_PER_POINT = 3;
export const PENALTY_SAVE_POINTS = 5;
export const PENALTY_MISS_POINTS = -2;
export const OWN_GOAL_POINTS = -2;
export const YELLOW_CARD_POINTS = -1;
export const RED_CARD_POINTS = -3;
export const GOALS_CONCEDED_PER_POINT = 2;   // -1 per 2 conceded, GKP/DEF only
export const DEFCON_POINTS = 2;

/** Combined defensive actions needed for the 2-point defensive contribution. */
export const DEFCON_THRESHOLD = {
  [DEF]: 10,   // clearances, blocks, interceptions, tackles
  [MID]: 12,   // ...plus ball recoveries
  [FWD]: 12,
  [GKP]: Infinity, // goalkeepers are not eligible
};

export const CHIPS = {
  none: { id: 'none', name: 'No chip' },
  wildcard: { id: 'wildcard', name: 'Wildcard', unlimitedTransfers: true, permanent: true },
  freehit: { id: 'freehit', name: 'Free Hit', unlimitedTransfers: true, permanent: false },
  bboost: { id: 'bboost', name: 'Bench Boost', benchCounts: true },
  '3xc': { id: '3xc', name: 'Triple Captain', captainMultiplier: 3 },
};

/** First set of chips expires at the GW19 deadline; the second set runs GW20-38. */
export const CHIP_HALF_BOUNDARY = 19;
export const TOTAL_GAMEWEEKS = 38;

export function chipHalf(gameweek) {
  return gameweek <= CHIP_HALF_BOUNDARY ? 'first' : 'second';
}

export function captainMultiplier(chip) {
  return chip === '3xc' ? 3 : 2;
}

/** Every legal outfield shape: 3-5 DEF, 2-5 MID, 1-3 FWD, ten outfielders. */
export const FORMATIONS = (() => {
  const out = [];
  for (let d = POSITIONS[DEF].min; d <= POSITIONS[DEF].max; d++) {
    for (let m = POSITIONS[MID].min; m <= POSITIONS[MID].max; m++) {
      const f = 10 - d - m;
      if (f >= POSITIONS[FWD].min && f <= POSITIONS[FWD].max) out.push({ d, m, f, name: `${d}-${m}-${f}` });
    }
  }
  return out;
})();

/**
 * FPL banks half of any price rise, rounded down to the nearest £0.1m.
 * A fall is absorbed in full by the manager.
 * @param {number} purchase price paid, in tenths
 * @param {number} current  current price, in tenths
 */
export function sellingPrice(purchase, current) {
  if (current <= purchase) return current;
  return purchase + Math.floor((current - purchase) / 2);
}

/** Points deducted for making `used` transfers with `free` available. */
export function hitCost(used, free) {
  return Math.max(0, used - free) * TRANSFER_HIT;
}

export const money = (tenths) => `£${(tenths / 10).toFixed(1)}m`;
