// Turns the data loaded for a place into a shortlist snapshot. Pure functions with no DOM,
// shared by the page (app.js) and the server (lib/shortlist.mjs), and run by the Node tests.

/** Stable id for a place: a normalised postcode, or the lower-cased place name. */
export function shortlistId(query) {
  const q = String(query || '').trim();
  const s = q.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s)) return `${s.slice(0, -3)} ${s.slice(-3)}`;
  return q.toLowerCase().replace(/\s+/g, ' ');
}

export const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
export const chance = (s) => s.catchment?.estimate || s.catchment?.status || 'na';
export const goodChance = (s) => ['in', 'likely'].includes(chance(s));
const NO_FAITH_VALUES = ['Does not apply', 'None', 'Unknown', null, undefined, ''];
export const isFaithSchool = (s) => !NO_FAITH_VALUES.includes(s.religion);

/** Walking time to the station, from straight-line distance at 80 m a minute (a bit optimistic). */
export const walkMinutes = (metres) => Math.ceil(metres / 80);

/** Crime this year against the year before, as a whole percentage, or null without history. */
export function crimeTrendPct(c, now = c.total, before = c.previous?.total) {
  if (!c.previous || !before) return null;
  return Math.round(((now - before) / before) * 100);
}

const usable = (x) => x && !x.error && x.ready !== false;
const isoDay = (d) => d.toISOString().slice(0, 10);

/** Nearest Outstanding school in a phase you'd likely get into, else the nearest Outstanding one. */
function pickSchool(schools, phase, settings) {
  const list = schools
    .filter((s) => s.phase === phase && s.rating?.tone === 'great' && s.distance <= (settings.schoolRadius || 3000))
    .filter((s) => !(settings.hideFaith && isFaithSchool(s)))
    .sort((a, b) => a.distance - b.distance);
  const s = list.find(goodChance) || list[0];
  if (!s) return null;
  return { name: s.name, distance: s.distance, label: s.catchment?.label || '', estimate: chance(s), likely: goodChance(s) };
}

/** Everything the shortlist row shows, built from the data loaded for a place. */
export function buildSnapshot({ transport, schools, prices, crime, flood }, settings = {}, now = new Date()) {
  const asOf = isoDay(now);
  const out = { transport: null, schools: null, prices: null, crime: null, flood: null };

  if (usable(transport)) {
    const st = transport.stations?.[0];
    const d = transport.doorToDoor;
    out.transport = {
      asOf,
      destination: transport.destination,
      station: st ? { name: st.name, distance: st.distance, walkMin: walkMinutes(st.distance) } : null,
      door: d?.minutes && !d.error ? { minutes: d.minutes, changes: d.changes } : null,
    };
  }
  if (usable(schools) && schools.schools) {
    out.schools = { asOf, radius: settings.schoolRadius || 3000, primary: pickSchool(schools.schools, 'Primary', settings), secondary: pickSchool(schools.schools, 'Secondary', settings) };
  }
  if (usable(prices) && prices.sales) {
    let sales = prices.sales;
    const min = Number(settings.priceSize) || 0;
    if (prices.epc?.enabled && min) sales = sales.filter((s) => s.habitableRooms >= min);
    const of = (type) => { const p = sales.filter((s) => s.type === type).map((s) => s.price); return { median: median(p), count: p.length }; };
    out.prices = { asOf, radiusM: settings.priceRadius, years: settings.priceYears, sizeMin: prices.epc?.enabled ? min : 0, detached: of('Detached'), semi: of('Semi-detached') };
  }
  if (usable(crime) && crime.monthsCounted) {
    out.crime = { asOf, perMonth: crime.total / crime.monthsCounted, trendPct: crimeTrendPct(crime) };
  }
  if (usable(flood)) {
    out.flood = { asOf, covered: flood.covered, medHigh: flood.medHigh, verdict: flood.verdict, label: flood.label };
  }
  return out;
}

/** A refresh replaces each section that came back, and keeps the old one where it failed.
 *  With new settings, only crime and flood (which don't depend on settings) are kept. */
export function mergeSnapshot(old = {}, fresh = {}, { settingsChanged = false } = {}) {
  const out = {};
  for (const k of ['transport', 'schools', 'prices', 'crime', 'flood']) {
    const keep = !settingsChanged || k === 'crime' || k === 'flood';
    out[k] = fresh[k] ?? (keep ? old[k] : null) ?? null;
  }
  return out;
}

const FAITH_NAMES = { none: 'no faith', coe: 'Church of England', catholic: 'Catholic', christian: 'other Christian', jewish: 'Jewish', muslim: 'Muslim', hindu: 'Hindu', sikh: 'Sikh' };

/** "faith: Catholic · faith schools hidden": which faith setting a row's school picks used. */
export function faithLabel(settings = {}) {
  return `faith: ${FAITH_NAMES[settings.faith] || 'not set'}${settings.hideFaith ? ' · faith schools hidden' : ''}`;
}

/** True when saved rows used different faith settings, so their school columns aren't like for like. */
export function faithSettingsDiffer(entries) {
  const keys = new Set(entries.map((e) => `${e.settings?.faith || ''}|${Boolean(e.settings?.hideFaith)}`));
  return keys.size > 1;
}

// For each column: how to read a row's value (lower is better; null means no value).
const COLUMNS = {
  walk: (s) => s.transport?.station?.walkMin,
  door: (s) => s.transport?.door?.minutes,
  primary: (s) => (s.schools?.primary?.likely ? s.schools.primary.distance : null),
  secondary: (s) => (s.schools?.secondary?.likely ? s.schools.secondary.distance : null),
  detached: (s) => s.prices?.detached?.median,
  semi: (s) => s.prices?.semi?.median,
  crime: (s) => s.crime?.perMonth,
  flood: (s) => (s.flood?.covered ? s.flood.medHigh : null),
};

/** Which rows get the green "best" shading in each column. Needs at least two rows to compare. */
export function bestInColumn(entries) {
  const out = {};
  for (const [col, get] of Object.entries(COLUMNS)) {
    const vals = entries.map((e) => [e.id, get(e.snapshot || {})]).filter(([, v]) => v != null);
    if (vals.length < 2) { out[col] = []; continue; }
    const min = Math.min(...vals.map(([, v]) => v));
    out[col] = vals.filter(([, v]) => v === min).map(([id]) => id);
  }
  return out;
}

/* ───────── Overall score (the owner chose adjustable weights, 17 Oct 2026) ───────── */

export const WEIGHT_VALUES = { high: 3, medium: 2, low: 1, off: 0 };
export const DEFAULT_WEIGHTS = { door: 'high', schools: 'high', price: 'high', walk: 'medium', crime: 'medium', flood: 'low' };
export const FACTOR_NAMES = { door: 'commute', schools: 'schools', price: 'price', walk: 'walk', crime: 'crime', flood: 'flood' };

// Lower is better for each; null means no figure. Price is the cheaper of the detached and semi medians.
const FACTORS = {
  door: (s) => s.transport?.door?.minutes,
  schools: (s) => s.schools,
  price: (s) => {
    const p = [s.prices?.detached?.median, s.prices?.semi?.median].filter((v) => v != null);
    return p.length ? Math.min(...p) : null;
  },
  walk: (s) => s.transport?.station?.walkMin,
  crime: (s) => s.crime?.perMonth,
  flood: (s) => (s.flood?.covered ? s.flood.medHigh : null),
};

// Schools aren't compared between places: a likely Outstanding school is full marks, an Outstanding one
// you'd probably not get into is 30, none is 0. Primary and secondary are averaged.
const phaseScore = (p) => (!p ? 0 : p.likely ? 100 : 30);

/** Score each shortlist row 0-100 from weighted factors. Other factors are scaled across the shortlist
 *  (best 100, worst 0). A missing figure is left out of that row's score, not counted against it.
 *  Returns { [id]: { score, rank, wins, losses, missing } }; wins/losses are factor keys. */
export function scoreShortlist(entries, weights = DEFAULT_WEIGHTS) {
  const active = Object.keys(FACTORS).filter((k) => (WEIGHT_VALUES[weights[k]] ?? 0) > 0);
  const per = {}; // factor -> id -> 0..100, plus whether the factor separates places at all
  const spread = {};
  for (const k of active) {
    per[k] = {};
    if (k === 'schools') {
      for (const e of entries) {
        const s = e.snapshot?.schools;
        if (s) per[k][e.id] = (phaseScore(s.primary) + phaseScore(s.secondary)) / 2;
      }
      const v = Object.values(per[k]);
      spread[k] = v.length > 1 && Math.max(...v) !== Math.min(...v);
      continue;
    }
    const vals = entries.map((e) => [e.id, FACTORS[k](e.snapshot || {})]).filter(([, v]) => v != null);
    const lo = Math.min(...vals.map(([, v]) => v));
    const hi = Math.max(...vals.map(([, v]) => v));
    spread[k] = vals.length > 1 && hi > lo;
    for (const [id, v] of vals) per[k][id] = hi > lo ? (100 * (hi - v)) / (hi - lo) : 100;
  }
  const out = {};
  for (const e of entries) {
    let sum = 0;
    let total = 0;
    const missing = [];
    for (const k of active) {
      const v = per[k][e.id];
      if (v == null) { missing.push(k); continue; }
      sum += v * WEIGHT_VALUES[weights[k]];
      total += WEIGHT_VALUES[weights[k]];
    }
    const score = total ? Math.round(sum / total) : null;
    const counted = active.filter((k) => spread[k] && per[k][e.id] != null);
    out[e.id] = {
      score,
      rank: null,
      // At most two each, strongest (or weakest) first, so the cell stays readable.
      wins: score == null ? [] : counted.filter((k) => per[k][e.id] >= 75).sort((a, b) => per[b][e.id] - per[a][e.id]).slice(0, 2),
      losses: score == null ? [] : counted.filter((k) => per[k][e.id] <= 25).sort((a, b) => per[a][e.id] - per[b][e.id]).slice(0, 2),
      missing: score == null ? [] : missing,
    };
  }
  const scores = Object.values(out).map((o) => o.score).filter((s) => s != null);
  for (const o of Object.values(out)) if (o.score != null) o.rank = 1 + scores.filter((s) => s > o.score).length;
  return out;
}
