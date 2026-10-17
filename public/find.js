// Find places: the rules that decide whether a station passes. Pure functions, shared by
// the page and the tests, so changing a setting re-filters without new requests.
import { median } from './snapshot.js';
import { friendlyError } from './errors.js';

export const MIN_WALK = 5; // minutes; less than this leaves too few homes to judge
export const MAX_WALK = 15; // minutes; prices are fetched within this walk (1.2 km), so never allow more
export const WALK_M_PER_MIN = 80;
export const MIN_SALES = 5;
// EPC habitable rooms = bedrooms plus living and dining rooms, so N+ bedrooms is about N+1 rooms.
export const BEDS = [3, 4, 5];
export const DEFAULT_BEDS = 4;
export const roomsFor = (beds) => beds + 1;

/** Minutes of walk left once the train is taken off the door-to-door limit, capped at the max walk.
 *  null when the station is too slow (or couldn't be planned). */
export function walkAllowance(trainMin, { maxDoor = 60, maxWalk = 15 } = {}) {
  if (trainMin == null) return null;
  const mins = Math.min(maxWalk, MAX_WALK, maxDoor - trainMin);
  return mins >= MIN_WALK ? mins : null;
}

/** The Schools setting. A station's school per phase is already the best likely Good+ one,
 *  Outstanding first, so "great" means an Outstanding school you'd likely get into. */
export const SCHOOL_LEVELS = {
  good: 'Good or Outstanding',
  primary: 'Outstanding primary',
  secondary: 'Outstanding secondary',
  both: 'Outstanding primary and secondary',
};

export function schoolsPass(station, level = 'good') {
  const { primary: p, secondary: s } = station;
  if (!p || !s) return false;
  const top = (x) => x.tone === 'great';
  if (level === 'primary') return top(p);
  if (level === 'secondary') return top(s);
  if (level === 'both') return top(p) && top(s);
  return true;
}

/** The Area setting. "Outside London" means outside Greater London, so it includes zones 7-9. */
export const AREAS = {
  outside: 'Outside London (incl. zones 7–9)',
  london: 'Greater London (zones 3–6)',
  both: 'Both',
};

export function areaPass(station, area = 'outside') {
  if (area === 'both') return true;
  return area === 'london' ? Boolean(station.london) : !station.london;
}

/** A TfL zone ("4", "2+3", "2/3", "6+7") is in range if any of its zones is 3 to 6. Zones 1-2 are left
 *  out because 4-bed houses there are almost always over the top budget. */
export function inLondonZones(zone) {
  return String(zone ?? '').split(/[+/]/).map(Number).some((z) => z >= 3 && z <= 6);
}

/** Straight-line metres between two points. */
function metres(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180;
  const x = (bLng - aLng) * r * Math.cos(((aLat + bLat) / 2) * r);
  const y = (bLat - aLat) * r;
  return Math.sqrt(x * x + y * y) * 6371000;
}

/** Shortlisted places within walking range of a station (the area Find places prices), nearest first. */
export function shortlistedNear(station, entries = [], maxM = MAX_WALK * WALK_M_PER_MIN) {
  return (entries || [])
    .filter((e) => Number.isFinite(e.lat) && Number.isFinite(e.lng))
    .map((e) => ({ e, d: metres(station.lat, station.lng, e.lat, e.lng) }))
    .filter((x) => x.d <= maxM)
    .sort((a, b) => a.d - b.d)
    .map((x) => x.e);
}

export const PAGE_SIZE = 20;

/** One page of a list, with the page number kept in range. */
export function pageOf(items, page, size = PAGE_SIZE) {
  const pages = Math.max(1, Math.ceil(items.length / size));
  const p = Math.min(Math.max(1, page || 1), pages);
  const start = (p - 1) * size;
  return { items: items.slice(start, start + size), page: p, pages, start };
}

const shortMoney = (n) => (n >= 1e6 ? `£${(n / 1e6).toFixed(2).replace(/0$/, '')}m` : `£${Math.round(n / 1000)}k`);

/** Does a station's typical price for N+ bedrooms (default 4) fit the budget? `p` is the /api/find/price body.
 *  status: 'pass' | 'over' | 'unknown' (never a pass) | 'needs-epc' (fetch again with this budget). */
export function priceVerdict(p, { allowanceMin, budget, beds = DEFAULT_BEDS }) {
  const out = (status, reason, extra = {}) => ({ status, reason, median: null, count: 0, allSizes: false, ...extra });
  if (!p || p.error) return out('unknown', p ? friendlyError(p.error) : 'Price not checked');
  const epc = p.epc || {};
  if (!p.sales?.length) return out('unknown', 'No sales nearby');
  if (epc.enabled && !epc.ran) {
    return p.allSizesMedian > budget ? out('over', 'Every house nearby is over budget') : out('needs-epc', 'Checking room counts…');
  }
  if (epc.enabled && epc.error) return out('unknown', 'The energy certificate service isn\'t responding');
  const maxM = allowanceMin * WALK_M_PER_MIN;
  const prices = (p.sales || [])
    .filter((s) => s.distance <= maxM && (!epc.enabled || s.rooms >= roomsFor(beds)))
    .map((s) => s.price);
  const allSizes = !epc.enabled;
  if (prices.length < MIN_SALES) return out('unknown', 'Not enough sales', { count: prices.length, allSizes });
  const m = median(prices);
  return m <= budget
    ? out('pass', '', { median: m, count: prices.length, allSizes })
    : out('over', `over budget by ${shortMoney(m - budget)}`, { median: m, count: prices.length, allSizes });
}

/** Stations that pass the commute and schools rules, fastest train first. */
export function rankStations(stations, settings) {
  return stations
    .map((s) => ({ ...s, allowanceMin: walkAllowance(s.trainMin, settings) }))
    .filter((s) => s.allowanceMin != null && areaPass(s, settings.area) && schoolsPass(s, settings.schools))
    .sort((a, b) => a.trainMin - b.trainMin || a.name.localeCompare(b.name));
}

/** A price that failed for a passing reason (a lookup error or an EPC outage), worth asking for again. */
export const retryable = (p) => Boolean(p && (p.error || p.epc?.error));
