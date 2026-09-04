/**
 * Canonical NFL team registry.
 *
 * Every external feed spells teams differently ("KC", "Kansas City Chiefs",
 * "Kansas City", "KAN"). Everything entering the app goes through
 * {@link normalizeTeam} first, so joins are always on the 32 canonical abbrs.
 */

export type Conference = "AFC" | "NFC";
export type RoofType = "outdoors" | "dome" | "retractable";

export interface TeamMeta {
  abbr: string;
  location: string;
  nickname: string;
  name: string;
  conference: Conference;
  division: string;
  primary: string;
  secondary: string;
  stadium: string;
  stadiumLat: number;
  stadiumLon: number;
  roofType: RoofType;
  /** Extra spellings seen in the wild. Canonical abbr + name are added automatically. */
  aliases: string[];
}

export const TEAMS: TeamMeta[] = [
  { abbr: "ARI", location: "Arizona", nickname: "Cardinals", name: "Arizona Cardinals", conference: "NFC", division: "NFC West", primary: "#97233F", secondary: "#000000", stadium: "State Farm Stadium", stadiumLat: 33.5276, stadiumLon: -112.2626, roofType: "retractable", aliases: ["ARZ", "PHO", "Phoenix Cardinals", "Arizona"] },
  { abbr: "ATL", location: "Atlanta", nickname: "Falcons", name: "Atlanta Falcons", conference: "NFC", division: "NFC South", primary: "#A71930", secondary: "#000000", stadium: "Mercedes-Benz Stadium", stadiumLat: 33.7554, stadiumLon: -84.4008, roofType: "retractable", aliases: ["Atlanta"] },
  { abbr: "BAL", location: "Baltimore", nickname: "Ravens", name: "Baltimore Ravens", conference: "AFC", division: "AFC North", primary: "#241773", secondary: "#9E7C0C", stadium: "M&T Bank Stadium", stadiumLat: 39.278, stadiumLon: -76.6227, roofType: "outdoors", aliases: ["BLT", "Baltimore"] },
  { abbr: "BUF", location: "Buffalo", nickname: "Bills", name: "Buffalo Bills", conference: "AFC", division: "AFC East", primary: "#00338D", secondary: "#C60C30", stadium: "Highmark Stadium", stadiumLat: 42.7714, stadiumLon: -78.7885, roofType: "outdoors", aliases: ["Buffalo"] },
  { abbr: "CAR", location: "Carolina", nickname: "Panthers", name: "Carolina Panthers", conference: "NFC", division: "NFC South", primary: "#0085CA", secondary: "#101820", stadium: "Bank of America Stadium", stadiumLat: 35.2258, stadiumLon: -80.8528, roofType: "outdoors", aliases: ["Carolina"] },
  { abbr: "CHI", location: "Chicago", nickname: "Bears", name: "Chicago Bears", conference: "NFC", division: "NFC North", primary: "#0B162A", secondary: "#C83803", stadium: "Soldier Field", stadiumLat: 41.8623, stadiumLon: -87.6167, roofType: "outdoors", aliases: ["Chicago"] },
  { abbr: "CIN", location: "Cincinnati", nickname: "Bengals", name: "Cincinnati Bengals", conference: "AFC", division: "AFC North", primary: "#FB4F14", secondary: "#000000", stadium: "Paycor Stadium", stadiumLat: 39.0955, stadiumLon: -84.5161, roofType: "outdoors", aliases: ["Cincinnati"] },
  { abbr: "CLE", location: "Cleveland", nickname: "Browns", name: "Cleveland Browns", conference: "AFC", division: "AFC North", primary: "#311D00", secondary: "#FF3C00", stadium: "Huntington Bank Field", stadiumLat: 41.5061, stadiumLon: -81.6995, roofType: "outdoors", aliases: ["CLV", "Cleveland"] },
  { abbr: "DAL", location: "Dallas", nickname: "Cowboys", name: "Dallas Cowboys", conference: "NFC", division: "NFC East", primary: "#003594", secondary: "#869397", stadium: "AT&T Stadium", stadiumLat: 32.7473, stadiumLon: -97.0945, roofType: "retractable", aliases: ["Dallas"] },
  { abbr: "DEN", location: "Denver", nickname: "Broncos", name: "Denver Broncos", conference: "AFC", division: "AFC West", primary: "#FB4F14", secondary: "#002244", stadium: "Empower Field at Mile High", stadiumLat: 39.7439, stadiumLon: -105.0201, roofType: "outdoors", aliases: ["Denver"] },
  { abbr: "DET", location: "Detroit", nickname: "Lions", name: "Detroit Lions", conference: "NFC", division: "NFC North", primary: "#0076B6", secondary: "#B0B7BC", stadium: "Ford Field", stadiumLat: 42.34, stadiumLon: -83.0456, roofType: "dome", aliases: ["Detroit"] },
  { abbr: "GB", location: "Green Bay", nickname: "Packers", name: "Green Bay Packers", conference: "NFC", division: "NFC North", primary: "#203731", secondary: "#FFB612", stadium: "Lambeau Field", stadiumLat: 44.5013, stadiumLon: -88.0622, roofType: "outdoors", aliases: ["GNB", "Green Bay"] },
  { abbr: "HOU", location: "Houston", nickname: "Texans", name: "Houston Texans", conference: "AFC", division: "AFC South", primary: "#03202F", secondary: "#A71930", stadium: "NRG Stadium", stadiumLat: 29.6847, stadiumLon: -95.4107, roofType: "retractable", aliases: ["HST", "Houston"] },
  { abbr: "IND", location: "Indianapolis", nickname: "Colts", name: "Indianapolis Colts", conference: "AFC", division: "AFC South", primary: "#002C5F", secondary: "#A2AAAD", stadium: "Lucas Oil Stadium", stadiumLat: 39.7601, stadiumLon: -86.1639, roofType: "retractable", aliases: ["CLT", "Indianapolis"] },
  { abbr: "JAX", location: "Jacksonville", nickname: "Jaguars", name: "Jacksonville Jaguars", conference: "AFC", division: "AFC South", primary: "#101820", secondary: "#D7A22A", stadium: "EverBank Stadium", stadiumLat: 30.3239, stadiumLon: -81.6373, roofType: "outdoors", aliases: ["JAC", "Jacksonville"] },
  { abbr: "KC", location: "Kansas City", nickname: "Chiefs", name: "Kansas City Chiefs", conference: "AFC", division: "AFC West", primary: "#E31837", secondary: "#FFB81C", stadium: "GEHA Field at Arrowhead Stadium", stadiumLat: 39.0489, stadiumLon: -94.4839, roofType: "outdoors", aliases: ["KAN", "Kansas City"] },
  { abbr: "LA", location: "Los Angeles", nickname: "Rams", name: "Los Angeles Rams", conference: "NFC", division: "NFC West", primary: "#003594", secondary: "#FFA300", stadium: "SoFi Stadium", stadiumLat: 33.9535, stadiumLon: -118.3392, roofType: "dome", aliases: ["LAR", "STL", "RAM", "St. Louis Rams", "Los Angeles Rams"] },
  { abbr: "LAC", location: "Los Angeles", nickname: "Chargers", name: "Los Angeles Chargers", conference: "AFC", division: "AFC West", primary: "#0080C6", secondary: "#FFC20E", stadium: "SoFi Stadium", stadiumLat: 33.9535, stadiumLon: -118.3392, roofType: "dome", aliases: ["SD", "SDG", "San Diego Chargers", "Los Angeles Chargers"] },
  { abbr: "LV", location: "Las Vegas", nickname: "Raiders", name: "Las Vegas Raiders", conference: "AFC", division: "AFC West", primary: "#000000", secondary: "#A5ACAF", stadium: "Allegiant Stadium", stadiumLat: 36.0909, stadiumLon: -115.1833, roofType: "dome", aliases: ["LVR", "OAK", "RAI", "Oakland Raiders", "Las Vegas"] },
  { abbr: "MIA", location: "Miami", nickname: "Dolphins", name: "Miami Dolphins", conference: "AFC", division: "AFC East", primary: "#008E97", secondary: "#FC4C02", stadium: "Hard Rock Stadium", stadiumLat: 25.958, stadiumLon: -80.2389, roofType: "outdoors", aliases: ["Miami"] },
  { abbr: "MIN", location: "Minnesota", nickname: "Vikings", name: "Minnesota Vikings", conference: "NFC", division: "NFC North", primary: "#4F2683", secondary: "#FFC62F", stadium: "U.S. Bank Stadium", stadiumLat: 44.9736, stadiumLon: -93.2575, roofType: "dome", aliases: ["Minnesota"] },
  { abbr: "NE", location: "New England", nickname: "Patriots", name: "New England Patriots", conference: "AFC", division: "AFC East", primary: "#002244", secondary: "#C60C30", stadium: "Gillette Stadium", stadiumLat: 42.0909, stadiumLon: -71.2643, roofType: "outdoors", aliases: ["NWE", "New England"] },
  { abbr: "NO", location: "New Orleans", nickname: "Saints", name: "New Orleans Saints", conference: "NFC", division: "NFC South", primary: "#D3BC8D", secondary: "#101820", stadium: "Caesars Superdome", stadiumLat: 29.9511, stadiumLon: -90.0812, roofType: "dome", aliases: ["NOR", "New Orleans"] },
  { abbr: "NYG", location: "New York", nickname: "Giants", name: "New York Giants", conference: "NFC", division: "NFC East", primary: "#0B2265", secondary: "#A71930", stadium: "MetLife Stadium", stadiumLat: 40.8135, stadiumLon: -74.0745, roofType: "outdoors", aliases: ["NY Giants", "New York Giants"] },
  { abbr: "NYJ", location: "New York", nickname: "Jets", name: "New York Jets", conference: "AFC", division: "AFC East", primary: "#125740", secondary: "#000000", stadium: "MetLife Stadium", stadiumLat: 40.8135, stadiumLon: -74.0745, roofType: "outdoors", aliases: ["NY Jets", "New York Jets"] },
  { abbr: "PHI", location: "Philadelphia", nickname: "Eagles", name: "Philadelphia Eagles", conference: "NFC", division: "NFC East", primary: "#004C54", secondary: "#A5ACAF", stadium: "Lincoln Financial Field", stadiumLat: 39.9008, stadiumLon: -75.1675, roofType: "outdoors", aliases: ["Philadelphia"] },
  { abbr: "PIT", location: "Pittsburgh", nickname: "Steelers", name: "Pittsburgh Steelers", conference: "AFC", division: "AFC North", primary: "#FFB612", secondary: "#101820", stadium: "Acrisure Stadium", stadiumLat: 40.4468, stadiumLon: -80.0158, roofType: "outdoors", aliases: ["Pittsburgh"] },
  { abbr: "SEA", location: "Seattle", nickname: "Seahawks", name: "Seattle Seahawks", conference: "NFC", division: "NFC West", primary: "#002244", secondary: "#69BE28", stadium: "Lumen Field", stadiumLat: 47.5952, stadiumLon: -122.3316, roofType: "outdoors", aliases: ["Seattle"] },
  { abbr: "SF", location: "San Francisco", nickname: "49ers", name: "San Francisco 49ers", conference: "NFC", division: "NFC West", primary: "#AA0000", secondary: "#B3995D", stadium: "Levi's Stadium", stadiumLat: 37.4033, stadiumLon: -121.9694, roofType: "outdoors", aliases: ["SFO", "San Francisco", "Niners"] },
  { abbr: "TB", location: "Tampa Bay", nickname: "Buccaneers", name: "Tampa Bay Buccaneers", conference: "NFC", division: "NFC South", primary: "#D50A0A", secondary: "#0A0A08", stadium: "Raymond James Stadium", stadiumLat: 27.9759, stadiumLon: -82.5033, roofType: "outdoors", aliases: ["TAM", "Tampa Bay", "Bucs"] },
  { abbr: "TEN", location: "Tennessee", nickname: "Titans", name: "Tennessee Titans", conference: "AFC", division: "AFC South", primary: "#0C2340", secondary: "#4B92DB", stadium: "Nissan Stadium", stadiumLat: 36.1665, stadiumLon: -86.7713, roofType: "outdoors", aliases: ["OTI", "HOU Oilers", "Tennessee"] },
  { abbr: "WAS", location: "Washington", nickname: "Commanders", name: "Washington Commanders", conference: "NFC", division: "NFC East", primary: "#5A1414", secondary: "#FFB612", stadium: "Northwest Stadium", stadiumLat: 38.9076, stadiumLon: -76.8645, roofType: "outdoors", aliases: ["WSH", "WFT", "Washington Football Team", "Washington Redskins", "Washington"] },
];

export const TEAM_ABBRS: string[] = TEAMS.map((t) => t.abbr);

const BY_ABBR = new Map<string, TeamMeta>(TEAMS.map((t) => [t.abbr, t]));

/** Loose key: uppercase, letters+digits only. "Kansas City Chiefs" -> "KANSASCITYCHIEFS". */
function key(raw: string): string {
  return raw.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const LOOKUP = new Map<string, string>();
for (const t of TEAMS) {
  const forms = [t.abbr, t.name, t.location, t.nickname, `${t.location} ${t.nickname}`, ...t.aliases];
  for (const f of forms) {
    const k = key(f);
    // Ambiguous bare forms ("New York", "Los Angeles") are resolved by nickname only.
    if (LOOKUP.has(k) && LOOKUP.get(k) !== t.abbr) {
      LOOKUP.set(k, "__AMBIGUOUS__");
      continue;
    }
    LOOKUP.set(k, t.abbr);
  }
}

/**
 * Resolve any provider spelling to a canonical abbreviation.
 * Returns `null` rather than guessing when the input is unknown or ambiguous —
 * a silent wrong join is far more damaging than a visible miss.
 */
export function normalizeTeam(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const direct = LOOKUP.get(key(raw));
  if (direct && direct !== "__AMBIGUOUS__") return direct;

  // Fall back to a nickname match anywhere in the string ("The Kansas City Chiefs").
  const k = key(raw);
  const hits = TEAMS.filter((t) => k.includes(key(t.nickname)));
  if (hits.length === 1) return hits[0].abbr;
  return null;
}

/** Same as {@link normalizeTeam} but throws — use where a miss is a programming error. */
export function requireTeam(raw: string | null | undefined): string {
  const abbr = normalizeTeam(raw);
  if (!abbr) throw new Error(`Unrecognised NFL team: ${JSON.stringify(raw)}`);
  return abbr;
}

export function getTeam(abbr: string): TeamMeta {
  const t = BY_ABBR.get(abbr);
  if (!t) throw new Error(`Unknown canonical team abbr: ${abbr}`);
  return t;
}

export function maybeTeam(abbr: string | null | undefined): TeamMeta | null {
  if (!abbr) return null;
  return BY_ABBR.get(abbr) ?? null;
}

export function teamName(abbr: string): string {
  return BY_ABBR.get(abbr)?.name ?? abbr;
}

export function teamShort(abbr: string): string {
  return BY_ABBR.get(abbr)?.nickname ?? abbr;
}
