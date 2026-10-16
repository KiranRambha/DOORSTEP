import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, fetchJson, cached, distanceM, offset, median, mapLimit, normalisePostcode } from './util.mjs';
import { refineRating } from './ofsted.mjs';
import { addCatchment } from './catchment.mjs';

/* ───────────────────────── Location ───────────────────────── */

/** Turn a postcode or place name into a point. */
export async function lookupLocation(q) {
  const query = String(q || '').trim();
  if (!query) throw Object.assign(new Error('Enter a postcode or place name.'), { status: 400 });

  const pc = normalisePostcode(query);
  if (pc && /^[A-Z]{1,2}\d[A-Z\d]? \d[A-Z]{2}$/.test(pc)) {
    const r = await cached(`pc:${pc}`, 24 * 30, () =>
      fetchJson(`https://api.postcodes.io/postcodes/${encodeURIComponent(pc)}`, { allow404: true }));
    if (r?.result) {
      const p = r.result;
      return { label: p.postcode, area: [p.admin_ward, p.admin_district].filter(Boolean).join(', '), lat: p.latitude, lng: p.longitude, country: p.country };
    }
    const t = await fetchJson(`https://api.postcodes.io/terminated_postcodes/${encodeURIComponent(pc)}`, { allow404: true });
    if (t?.result?.latitude) return { label: pc, area: 'Retired postcode', lat: t.result.latitude, lng: t.result.longitude };
  }

  const places = await cached(`place:${query.toLowerCase()}`, 24 * 30, () =>
    fetchJson(`https://api.postcodes.io/places?q=${encodeURIComponent(query)}&limit=10`));
  const list = (places?.result || []).filter((p) => ['England', 'Wales'].includes(p.country));
  if (!list.length) throw Object.assign(new Error(`Couldn't find "${query}". Try a full postcode such as SG5 1AB.`), { status: 404 });
  // Prefer towns/cities/suburbs over minor features with the same name.
  const rank = { City: 0, Town: 1, 'Suburban Area': 2, Village: 3, Hamlet: 4 };
  list.sort((a, b) => (rank[a.local_type] ?? 9) - (rank[b.local_type] ?? 9));
  const p = list[0];
  return {
    label: p.name_1,
    area: [p.local_type, p.district_borough || p.county_unitary].filter(Boolean).join(', '),
    lat: p.latitude,
    lng: p.longitude,
    country: p.country,
  };
}

/* ───────────────────────── Schools ───────────────────────── */

let schoolsCache = null;
function loadSchools() {
  if (schoolsCache) return schoolsCache;
  const file = path.join(DATA_DIR, 'schools.json');
  if (!fs.existsSync(file)) return null;
  schoolsCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const s of schoolsCache.schools) s.rating = refineRating(s.rating);
  return schoolsCache;
}

export function nearbySchools(lat, lng, radiusM = 3000, faith = null) {
  const data = loadSchools();
  if (!data) {
    return { ready: false, message: 'School data isn\'t downloaded yet. Run "npm run setup" in the project folder, then restart.' };
  }
  // Rank against every school within 8 km so "nth nearest" is right even for a small radius.
  const around = data.schools
    .map((s) => ({ ...s, distance: Math.round(distanceM(lat, lng, s.lat, s.lng)) }))
    .filter((s) => s.distance <= 8000);
  addCatchment(around, undefined, { faith });
  const schools = around
    .filter((s) => s.distance <= radiusM)
    .sort((a, b) => a.distance - b.distance)
    .slice(0, 120);
  return { ready: true, source: data.source, builtAt: data.builtAt, schools };
}

/* ───────────────────────── Stations & commute ───────────────────────── */

export const DESTINATIONS = {
  bank: { name: 'Bank (City of London)', lat: 51.5133, lng: -0.0890 },
  oxford: { name: 'Oxford Circus (West End)', lat: 51.5152, lng: -0.1419 },
  kingsx: { name: "King's Cross", lat: 51.5308, lng: -0.1238 },
  waterloo: { name: 'Waterloo', lat: 51.5031, lng: -0.1132 },
  liverpool: { name: 'Liverpool Street', lat: 51.5178, lng: -0.0823 },
  londonbridge: { name: 'London Bridge', lat: 51.5050, lng: -0.0865 },
  canary: { name: 'Canary Wharf', lat: 51.5049, lng: -0.0197 },
};

function tflKey() {
  return process.env.TFL_APP_KEY ? `&app_key=${encodeURIComponent(process.env.TFL_APP_KEY)}` : '';
}

/** Next Tuesday (a typical weekday, away from weekend engineering works) as YYYYMMDD. */
function nextTuesday() {
  const d = new Date();
  d.setDate(d.getDate() + (((2 - d.getDay() + 7) % 7) || 7));
  return d.toISOString().slice(0, 10).replace(/-/g, '');
}

async function nearestStations(lat, lng) {
  const types = 'NaptanRailStation,NaptanMetroStation';
  const modes = 'national-rail,tube,overground,elizabeth-line,dlr';
  for (const radius of [2000, 5000, 10000]) {
    const r = await fetchJson(
      `https://api.tfl.gov.uk/StopPoint?lat=${lat}&lon=${lng}&stopTypes=${types}&radius=${radius}&modes=${modes}${tflKey()}`,
    );
    const seen = new Set();
    const stops = (r.stopPoints || [])
      .map((s) => ({
        id: s.naptanId,
        name: s.commonName.replace(/ (Rail|Underground|DLR) Station$/, '').replace(/ Station$/, ''),
        lat: s.lat,
        lng: s.lon,
        modes: s.modes,
        lines: (s.lines || []).map((l) => l.name),
        distance: Math.round(distanceM(lat, lng, s.lat, s.lon)),
      }))
      .filter((s) => !seen.has(s.name) && seen.add(s.name))
      .sort((a, b) => a.distance - b.distance);
    if (stops.length) return stops.slice(0, 3);
  }
  return [];
}

const clean = (name) => (name || '').replace(/ (Rail|Underground|DLR) Station$/, '').replace(/ Station$/, '').replace(/^London /, '').trim();
const hhmm = (iso) => (iso ? iso.slice(11, 16) : null);

function summariseJourney(j) {
  const legs = (j.legs || []).map((l) => ({
    mode: l.mode?.name,
    minutes: l.duration,
    summary: l.instruction?.summary,
    line: l.routeOptions?.[0]?.name || null,
    towards: clean(l.routeOptions?.[0]?.directions?.[0]) || null,
    from: clean(l.departurePoint?.commonName),
    to: clean(l.arrivalPoint?.commonName),
    departs: hhmm(l.departureTime),
    arrives: hhmm(l.arrivalTime),
    stops: l.path?.stopPoints?.length || null,
    disrupted: Boolean(l.isDisrupted),
  }));
  const rides = legs.filter((l) => l.mode !== 'walking');
  // Where you change: the end of every ride except the last.
  const changeAt = rides.slice(0, -1).map((r) => r.to).filter(Boolean);
  return {
    minutes: j.duration,
    departs: hhmm(j.startDateTime),
    arrives: hhmm(j.arrivalDateTime),
    changes: Math.max(0, rides.length - 1),
    changeAt,
    legs,
  };
}

async function journey(from, to, date) {
  const url = `https://api.tfl.gov.uk/Journey/JourneyResults/${from.lat},${from.lng}/to/${to.lat},${to.lng}`
    + `?date=${date}&time=0900&timeIs=Arriving&journeyPreference=leasttime${tflKey()}`;
  const r = await fetchJson(url, { timeout: 40000 });
  const journeys = (r.journeys || []).map(summariseJourney).sort((a, b) => a.minutes - b.minutes);
  return journeys[0] || null;
}

export async function transport(lat, lng, destKey = 'bank') {
  const dest = DESTINATIONS[destKey] || DESTINATIONS.bank;
  const date = nextTuesday();
  return cached(`transport:v2:${lat.toFixed(4)},${lng.toFixed(4)}:${destKey}:${date}`, 24 * 7, async () => {
    const stations = await nearestStations(lat, lng);
    const [doorToDoor, ...fromStations] = await Promise.all([
      journey({ lat, lng }, dest, date).catch((e) => ({ error: e.message })),
      ...stations.map((s) => journey(s, dest, date).catch((e) => ({ error: e.message }))),
    ]);
    stations.forEach((s, i) => { s.toLondon = fromStations[i]; });
    return { destination: dest.name, arriveBy: '09:00', date, doorToDoor, stations };
  });
}

/* ───────────────────────── Crime ───────────────────────── */

/** One month of street-level crime around a point, compacted for caching. */
function fetchCrimeMonth(lat, lng, month) {
  const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
  return cached(`crime:v2:${key}:${month}`, Infinity, async () => {
    const list = await fetchJson(`https://data.police.uk/api/crimes-street/all-crime?lat=${lat}&lng=${lng}&date=${month}`, { timeout: 40000 });
    const byCat = {};
    // Each report: [lat, lng, category, street]. Locations are anonymised "snap points".
    const points = [];
    for (const c of list) {
      byCat[c.category] = (byCat[c.category] || 0) + 1;
      const plat = Number(c.location?.latitude);
      const plng = Number(c.location?.longitude);
      const st = c.location?.street?.name?.replace(/^On or near /, '') || null;
      points.push([Number.isFinite(plat) ? +plat.toFixed(5) : null, Number.isFinite(plng) ? +plng.toFixed(5) : null, c.category, st]);
    }
    return { month, total: list.length, byCat, points };
  }).catch((e) => ({ month, error: e.message }));
}

/**
 * Last `months` months of crime within about a mile, with every report's location,
 * plus category totals for the `months` before that (for the year-on-year trend).
 */
export async function crime(lat, lng, months = 12) {
  const dates = await cached('police:dates', 24, () => fetchJson('https://data.police.uk/api/crimes-street-dates'));
  const recent = dates.slice(0, months).map((d) => d.date);
  const before = dates.slice(months, months * 2).map((d) => d.date);
  const [perMonth, prevMonths] = await Promise.all([
    mapLimit(recent, 4, (m) => fetchCrimeMonth(lat, lng, m)),
    mapLimit(before, 3, (m) => fetchCrimeMonth(lat, lng, m)),
  ]);

  const ok = perMonth.filter((m) => !m.error);
  const ordered = [...perMonth].reverse(); // oldest first
  const categories = {};
  const streets = {};
  const points = [];
  ordered.forEach((m, monthIdx) => {
    if (m.error) return;
    for (const [k, v] of Object.entries(m.byCat)) categories[k] = (categories[k] || 0) + v;
    for (const [plat, plng, cat, st] of m.points || []) {
      if (st) streets[st] = (streets[st] || 0) + 1;
      if (plat !== null && plng !== null) points.push([plat, plng, cat, st, monthIdx]);
    }
  });

  const prevOk = prevMonths.filter((m) => !m.error);
  const previous = prevOk.length === before.length && before.length === months
    ? { months: prevOk.length, from: before[before.length - 1], to: before[0], total: prevOk.reduce((a, m) => a + m.total, 0), byCat: prevOk.reduce((acc, m) => { for (const [k, v] of Object.entries(m.byCat)) acc[k] = (acc[k] || 0) + v; return acc; }, {}) }
    : null;

  return {
    radius: 'about 1 mile',
    centre: { lat, lng },
    months: ordered.map((m) => ({ month: m.month, total: m.total ?? null, error: m.error || null })),
    total: ok.reduce((a, m) => a + m.total, 0),
    monthsCounted: ok.length,
    labels: Object.fromEntries(Object.keys(categories).map((k) => [k, crimeLabel(k)])),
    categories: Object.entries(categories).map(([k, v]) => ({ category: k, label: crimeLabel(k), count: v })).sort((a, b) => b.count - a.count),
    hotspots: Object.entries(streets).map(([street, count]) => ({ street, count })).sort((a, b) => b.count - a.count).slice(0, 8),
    points,
    previous,
  };
}

const CRIME_LABELS = {
  'anti-social-behaviour': 'Anti-social behaviour',
  'bicycle-theft': 'Bicycle theft',
  burglary: 'Burglary',
  'criminal-damage-arson': 'Criminal damage & arson',
  drugs: 'Drugs',
  'other-theft': 'Other theft',
  'possession-of-weapons': 'Weapons possession',
  'public-order': 'Public order',
  robbery: 'Robbery',
  shoplifting: 'Shoplifting',
  'theft-from-the-person': 'Theft from the person',
  'vehicle-crime': 'Vehicle crime',
  'violent-crime': 'Violence & sexual offences',
  'other-crime': 'Other crime',
};
const crimeLabel = (k) => CRIME_LABELS[k] || k.replace(/-/g, ' ');

/* ───────────────────────── House prices ───────────────────────── */

/** Collect postcodes within radiusM of a point by sampling postcodes.io around it.
 *  Returns [{ postcode, country }]. `dense` samples more points, so busy towns aren't undercounted. */
export async function postcodesAround(lat, lng, radiusM, { dense = false } = {}) {
  const points = [{ lat, lng }];
  const rings = dense && radiusM <= 1100 ? [[300, 4], [600, 8], [900, 12]]
    : radiusM <= 600 ? [] : radiusM <= 1100 ? [[600, 6]] : [[600, 6], [1200, 12]];
  for (const [dist, n] of rings) {
    for (let i = 0; i < n; i++) {
      const a = (2 * Math.PI * i) / n;
      points.push(offset(lat, lng, dist * Math.cos(a), dist * Math.sin(a)));
    }
  }
  const lists = await mapLimit(points, 4, (p) =>
    fetchJson(`https://api.postcodes.io/postcodes?lat=${p.lat}&lon=${p.lng}&radius=2000&limit=100`)
      .then((r) => r.result || [])
      .catch(() => []));
  const pcs = new Map();
  for (const list of lists) {
    for (const p of list) {
      if (distanceM(lat, lng, p.latitude, p.longitude) <= radiusM) pcs.set(p.postcode, { postcode: p.postcode, country: p.country });
    }
  }
  return [...pcs.values()];
}

const LR_TYPES = {
  'http://landregistry.data.gov.uk/def/common/detached': 'Detached',
  'http://landregistry.data.gov.uk/def/common/semi-detached': 'Semi-detached',
};

async function landRegistrySales(postcodes, sinceIso) {
  const sales = [];
  for (let i = 0; i < postcodes.length; i += 250) {
    const chunk = postcodes.slice(i, i + 250);
    const query = `PREFIX lrppi: <http://landregistry.data.gov.uk/def/ppi/>
PREFIX lrcommon: <http://landregistry.data.gov.uk/def/common/>
PREFIX xsd: <http://www.w3.org/2001/XMLSchema#>
SELECT ?tx ?amount ?date ?type ?paon ?saon ?street ?town ?pc ?newBuild ?category WHERE {
  VALUES ?pc { ${chunk.map((p) => JSON.stringify(p)).join(' ')} }
  ?addr lrcommon:postcode ?pc .
  ?tx lrppi:propertyAddress ?addr ;
      lrppi:propertyType ?type ;
      lrppi:pricePaid ?amount ;
      lrppi:transactionDate ?date .
  FILTER(?type IN (lrcommon:detached, lrcommon:semi-detached))
  FILTER(?date >= "${sinceIso}"^^xsd:date)
  OPTIONAL { ?tx lrppi:newBuild ?newBuild }
  OPTIONAL { ?tx lrppi:transactionCategory ?category }
  OPTIONAL { ?addr lrcommon:paon ?paon }
  OPTIONAL { ?addr lrcommon:saon ?saon }
  OPTIONAL { ?addr lrcommon:street ?street }
  OPTIONAL { ?addr lrcommon:town ?town }
}`;
    const r = await fetchJson('https://landregistry.data.gov.uk/landregistry/query', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/sparql-results+json' },
      body: 'query=' + encodeURIComponent(query),
      timeout: 60000,
    });
    for (const b of r.results?.bindings || []) {
      const v = (k) => b[k]?.value ?? null;
      // Category B covers repossessions, buy-to-lets and transfers that skew prices.
      const standard = !v('category') || v('category').endsWith('standardPricePaidTransaction');
      sales.push({
        id: v('tx'),
        price: Number(v('amount')),
        date: v('date'),
        type: LR_TYPES[v('type')] || 'Other',
        paon: v('paon'),
        saon: v('saon'),
        street: v('street'),
        town: v('town'),
        postcode: v('pc'),
        newBuild: v('newBuild') === 'true',
        standard,
      });
    }
  }
  // De-duplicate (OPTIONALs can multiply rows).
  const byId = new Map(sales.map((s) => [s.id, s]));
  return [...byId.values()].sort((a, b) => b.date.localeCompare(a.date));
}

export async function prices(lat, lng, { radiusM = 1000, years = 3 } = {}) {
  const since = new Date();
  since.setFullYear(since.getFullYear() - years);
  const sinceIso = since.toISOString().slice(0, 8) + '01';

  const key = `prices:v1:${lat.toFixed(4)},${lng.toFixed(4)}:${radiusM}:${sinceIso}`;
  const result = await cached(key, 24 * 7, async () => {
    const postcodes = (await postcodesAround(lat, lng, radiusM)).map((p) => p.postcode);
    const sales = postcodes.length ? await landRegistrySales(postcodes, sinceIso) : [];
    return { postcodesSearched: postcodes.length, since: sinceIso, sales };
  });

  let epc = { enabled: false };
  if (process.env.EPC_TOKEN) {
    const { enrichWithEpc } = await import('./epc.mjs');
    epc = await enrichWithEpc(result.sales).catch((e) => ({ enabled: true, error: e.message }));
  }

  const sales = result.sales.filter((s) => s.standard);
  const summary = {};
  for (const type of ['Detached', 'Semi-detached']) {
    const list = sales.filter((s) => s.type === type);
    const byYear = {};
    for (const s of list) (byYear[s.date.slice(0, 4)] ||= []).push(s.price);
    summary[type] = {
      count: list.length,
      median: median(list.map((s) => s.price)),
      low: list.length ? Math.min(...list.map((s) => s.price)) : null,
      high: list.length ? Math.max(...list.map((s) => s.price)) : null,
      byYear: Object.entries(byYear).sort().map(([year, p]) => ({ year, median: median(p), count: p.length })),
    };
  }
  return { ...result, sales, summary, epc, excluded: result.sales.length - sales.length };
}
