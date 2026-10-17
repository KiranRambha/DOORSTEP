// Find places: the pure rules, the station setup and the two API helpers. Offline; every API is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { walkAllowance, priceVerdict, rankStations, retryable, pageOf, inLondonZones, AREAS, shortlistedNear } from '../public/find.js';
import { nextTuesday } from '../lib/sources.mjs';

test('next Tuesday uses the local date, even just after midnight in summer time', () => {
  assert.equal(nextTuesday(new Date(2026, 9, 17, 0, 58)), '20261020'); // Sat 17 Oct, 00:58
  assert.equal(nextTuesday(new Date(2026, 9, 20, 12, 0)), '20261027'); // on a Tuesday: the next one
});

/* ───────── Pure rules ───────── */

test('walk allowance shrinks with the train and drops under 5 minutes', () => {
  assert.equal(walkAllowance(40, { maxDoor: 60, maxWalk: 15 }), 15);
  assert.equal(walkAllowance(50, { maxDoor: 60, maxWalk: 15 }), 10);
  assert.equal(walkAllowance(55, { maxDoor: 60, maxWalk: 15 }), 5);
  assert.equal(walkAllowance(56, { maxDoor: 60, maxWalk: 15 }), null);
  assert.equal(walkAllowance(null, {}), null);
});

test('walk allowance never goes past 15 minutes, the radius prices are fetched for', () => {
  assert.equal(walkAllowance(30, { maxDoor: 60, maxWalk: 20 }), 15);
});

const sale = (price, distance, rooms = 6) => ({ price, distance, rooms, type: 'Detached' });
const five = (price, distance = 300) => Array.from({ length: 5 }, () => sale(price, distance));

test('price: 4-bed median within the walk allowance against the budget', () => {
  const p = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: null },
    sales: [...five(700000), sale(2000000, 1100), sale(300000, 300, 3)] };
  const v = priceVerdict(p, { allowanceMin: 10, budget: 800000 }); // 800 m: drops the 1,100 m sale; 3 rooms dropped
  assert.equal(v.status, 'pass'); assert.equal(v.median, 700000); assert.equal(v.count, 5);
  const over = priceVerdict(p, { allowanceMin: 10, budget: 650000 });
  assert.equal(over.status, 'over');
  assert.match(over.reason, /over budget by £50k/);
});

test('price: unknown is never a pass', () => {
  const thin = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: null }, sales: five(500000).slice(0, 4) };
  assert.equal(priceVerdict(thin, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
  const outage = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: 'EPC down' }, sales: five(500000) };
  assert.equal(priceVerdict(outage, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
  assert.equal(priceVerdict({ error: 'postcodes.io down' }, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
});

test('price: cheap check rules out, or asks for EPC when the budget is raised', () => {
  const skipped = { allSizesMedian: 900000, epc: { enabled: true, ran: false, error: null }, sales: five(900000) };
  assert.equal(priceVerdict(skipped, { allowanceMin: 15, budget: 800000 }).status, 'over');
  assert.equal(priceVerdict(skipped, { allowanceMin: 15, budget: 950000 }).status, 'needs-epc');
});

test('price: a station with no sales is unknown, not a refetch loop', () => {
  const none = { allSizesMedian: null, epc: { enabled: true, ran: false, error: null }, sales: [] };
  assert.equal(priceVerdict(none, { allowanceMin: 15, budget: 800000 }).status, 'unknown');
});

test('retry: a failed lookup or EPC outage is worth retrying, a real answer is not', () => {
  assert.equal(retryable({ error: 'postcodes.io down' }), true);
  assert.equal(retryable({ epc: { enabled: true, ran: true, error: 'EPC down' }, sales: [] }), true);
  assert.equal(retryable({ epc: { enabled: true, ran: true, error: null }, sales: [] }), false); // no sales is an answer
  assert.equal(retryable(undefined), false);
});

test('price: without an EPC token, all detached and semi sales count and say so', () => {
  const p = { allSizesMedian: 600000, epc: { enabled: false, ran: false, error: null }, sales: five(600000).map((s) => ({ ...s, rooms: null })) };
  const v = priceVerdict(p, { allowanceMin: 15, budget: 700000 });
  assert.equal(v.status, 'pass'); assert.equal(v.allSizes, true);
});

test('ranking: commute and schools filter, fastest train first', () => {
  const st = (name, trainMin, ok = true) => ({ name, trainMin, primary: ok ? {} : null, secondary: {} });
  const out = rankStations([st('B', 50), st('A', 30), st('C', 58), st('D', 20, false), st('E', null)], { maxDoor: 60, maxWalk: 15 });
  assert.deepEqual(out.map((s) => s.name), ['A', 'B']);
  assert.equal(out[1].allowanceMin, 10);
});

test('price: the bedrooms setting moves the room threshold (beds + 1 habitable rooms)', () => {
  // Five 4-room houses at £500k and five 6-room houses at £900k, all close by.
  const sales = [...Array(5)].map(() => ({ price: 500000, distance: 100, rooms: 4 }))
    .concat([...Array(5)].map(() => ({ price: 900000, distance: 100, rooms: 6 })));
  const p = { allSizesMedian: 700000, epc: { enabled: true, ran: true, error: null }, sales };
  const at = (beds) => priceVerdict(p, { allowanceMin: 15, budget: 800000, beds });
  assert.equal(at(3).status, 'pass', '3+ bed: all ten count, median £700k');
  assert.equal(at(3).median, 700000);
  assert.equal(at(4).status, 'over', '4+ bed (default): only the 6-room houses');
  assert.equal(priceVerdict(p, { allowanceMin: 15, budget: 800000 }).status, 'over', 'default is 4+ bed');
  assert.equal(at(5).median, 900000, '5+ bed: 6 rooms still counts');
});

test('ranking: the schools setting can ask for Outstanding primary, secondary or both', () => {
  const st = (name, p, s) => ({ name, trainMin: 30, primary: { tone: p }, secondary: { tone: s } });
  const all = [st('GG', 'good', 'good'), st('OG', 'great', 'good'), st('GO', 'good', 'great'), st('OO', 'great', 'great')];
  const names = (schools) => rankStations(all, { maxDoor: 60, maxWalk: 15, schools }).map((x) => x.name).sort();
  assert.deepEqual(names(undefined), ['GG', 'GO', 'OG', 'OO'], 'default is Good or Outstanding');
  assert.deepEqual(names('good'), ['GG', 'GO', 'OG', 'OO']);
  assert.deepEqual(names('primary'), ['OG', 'OO']);
  assert.deepEqual(names('secondary'), ['GO', 'OO']);
  assert.deepEqual(names('both'), ['OO']);
});

test('zones: Greater London stations count if any zone is 3 to 6', () => {
  assert.equal(inLondonZones('4'), true);
  assert.equal(inLondonZones('2+3'), true);
  assert.equal(inLondonZones('2/3'), true);
  assert.equal(inLondonZones('6+7'), true);
  assert.equal(inLondonZones('1+2'), false);
  assert.equal(inLondonZones('2'), false);
  assert.equal(inLondonZones('7'), false);
  assert.equal(inLondonZones(undefined), false);
});

test('ranking: the area setting picks outside London, London or both', () => {
  const st = (name, london) => ({ name, trainMin: 30, london, primary: {}, secondary: {} });
  const all = [st('Out', false), st('Old', undefined), st('In', true)];
  const names = (area) => rankStations(all, { maxDoor: 60, maxWalk: 15, area }).map((x) => x.name).sort();
  assert.deepEqual(Object.keys(AREAS), ['outside', 'london', 'both']);
  assert.deepEqual(names(undefined), ['Old', 'Out'], 'default is outside London (old files have no london flag)');
  assert.deepEqual(names('london'), ['In']);
  assert.deepEqual(names('both'), ['In', 'Old', 'Out']);
});

test('shortlisted: saved places within 1.2 km of the station, nearest first', () => {
  const st = { lat: 51.8146, lng: -0.3515 };
  const saved = [
    { id: 'far', label: 'Far away', lat: 51.83, lng: -0.3515 }, // ~1.7 km
    { id: 'near', label: 'AL5 4FQ', lat: 51.8150, lng: -0.3515 }, // ~45 m
    { id: 'mid', label: 'AL5 2BB', lat: 51.8236, lng: -0.3515 }, // ~1 km
    { id: 'nowhere', label: 'No location' },
  ];
  assert.deepEqual(shortlistedNear(st, saved).map((e) => e.id), ['near', 'mid']);
  assert.deepEqual(shortlistedNear(st, []), []);
  assert.deepEqual(shortlistedNear(st, undefined), []);
});

test('pages: 20 a page, page number kept in range', () => {
  const items = Array.from({ length: 45 }, (_, i) => i);
  assert.deepEqual(pageOf(items, 1), { items: items.slice(0, 20), page: 1, pages: 3, start: 0 });
  assert.deepEqual(pageOf(items, 3), { items: items.slice(40), page: 3, pages: 3, start: 40 });
  assert.equal(pageOf(items, 9).page, 3, 'past the end goes to the last page');
  assert.equal(pageOf(items, 0).page, 1);
  assert.deepEqual(pageOf([], 2), { items: [], page: 1, pages: 1, start: 0 });
});

/* ───────── Station setup (mocked NaPTAN, postcodes.io and TfL) ───────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');

/** A throwaway copy of lib/ and public/ with its own data/ folder, so caches and files stay isolated. */
function tempProject(files = {}) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorstep-find-'));
  fs.cpSync(path.join(ROOT, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.cpSync(path.join(ROOT, 'public'), path.join(tmp, 'public'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'));
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(tmp, 'data', name), JSON.stringify(body));
  return tmp;
}

const stopZone = (id, zone) => ({ naptanId: id, additionalProperties: zone ? [{ key: 'Zone', value: zone }] : [] });
const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const NAPTAN = [
  'ATCOCode,CommonName,Longitude,Latitude,StopType,Status',
  '9100HRPNDN,Harpenden Rail Station,-0.35148,51.81464,RLY,active',
  '9100HRPNDNX,Harpenden Rail Station,-0.35150,51.81466,RLY,active', // NaPTAN lists some stations twice
  '9100CLPHMJN,Clapham Junction Rail Station,-0.1703,51.4642,RLY,active',
  '9100NRCH,Norwich Rail Station,1.3069,52.6273,RLY,active',
  '9100NOWHERE,Nowhere Rail Station,-0.2,51.9,RLY,active',
  '9100OLDSTN,Old Station Rail Station,-0.3,51.7,RLY,inactive',
].join('\n');

test('station setup: Clapham (zone 2) left out, fastest terminus, resume uses the cache', async () => {
  const tmp = tempProject();
  let tflCalls = 0;
  let inFlight = 0;
  let maxInFlight = 0;
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('naptan.api.dft.gov.uk')) return { ok: true, status: 200, text: async () => NAPTAN };
    if (u === 'https://api.postcodes.io/postcodes' && opts.method === 'POST') {
      const { geolocations } = JSON.parse(opts.body);
      return json({ status: 200, result: geolocations.map((g) => {
        const london = g.latitude < 51.5;
        return { query: g, result: [{ postcode: london ? 'SW11 2QP' : g.latitude > 51.85 ? 'SG4 0AA' : 'AL5 4FQ', region: london ? 'London' : 'East of England', country: 'England' }] };
      }) });
    }
    if (u.includes('api.tfl.gov.uk/StopPoint/Mode/')) return json({ stopPoints: [] });
    if (u.includes('api.tfl.gov.uk/StopPoint/910GCLPHMJN')) return json(stopZone('910GCLPHMJN', '2'));
    if (u.includes('api.tfl.gov.uk/Journey')) {
      tflCalls++;
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 2));
      inFlight--;
      // Station to station by TfL code: coordinates far from London get "No journey found".
      assert.match(u, /JourneyResults\/910G[A-Z]+\/to\/910G[A-Z]+\?/);
      if (u.includes('/910GNOWHERE/')) return json({ message: 'No journey found for your inputs.' }, 404);
      // TfL's duration counts walks at both ends; only the train time (08:25 to 08:52) should count.
      const fast = u.includes('/to/910GSTPXBOX');
      return json({ journeys: [{ duration: fast ? 42 : 60, startDateTime: '2026-10-20T08:17:00', arrivalDateTime: '2026-10-20T08:59:00', legs: [
        { mode: { name: 'walking' }, duration: 8, departureTime: '2026-10-20T08:17:00', arrivalTime: '2026-10-20T08:25:00', instruction: { summary: 'Walk' } },
        { mode: { name: 'national-rail' }, duration: fast ? 27 : 45, departureTime: '2026-10-20T08:25:00', arrivalTime: fast ? '2026-10-20T08:52:00' : '2026-10-20T09:10:00', instruction: { summary: 'Thameslink' }, routeOptions: [{ name: 'Thameslink' }] },
        { mode: { name: 'walking' }, duration: 7, departureTime: '2026-10-20T08:52:00', arrivalTime: '2026-10-20T08:59:00', instruction: { summary: 'Walk' } },
      ] }] });
    }
    throw new Error('Unexpected URL in test: ' + u);
  };
  const { buildStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const { TERMINI } = await import(path.join(tmp, 'lib', 'sources.mjs'));
  const lines = [];
  const out = await buildStations({ log: (m) => lines.push(m), gapMs: 0 });
  assert.ok(maxInFlight <= 4, `TfL calls in flight at once: ${maxInFlight}`); // TfL allows 500 a minute
  assert.deepEqual(out.stations.map((s) => s.name), ['Harpenden']);
  // Failed journeys are summarised by reason, so a bad run can be diagnosed.
  assert.ok(lines.some((l) => /16 journeys failed/.test(l) && /No journey found/.test(l)), lines.join('\n'));
  const h = out.stations[0];
  assert.equal(h.trainMin, 27); // the train only, not TfL's 42 with walks
  assert.equal(h.terminus, 'stpancras'); // the fastest of every terminus, wherever it is
  assert.equal(h.postcode, 'AL5 4FQ');
  assert.equal(TERMINI.length, 16);
  assert.equal(out.failed, 1); // Nowhere: no journey
  assert.equal(tflCalls, 48); // every terminus for both Harpenden entries and Nowhere
  tflCalls = 0;
  await buildStations({ log: () => {}, gapMs: 0 });
  assert.equal(tflCalls, 16); // Harpenden cached; Nowhere's failures retried
});

test('station setup: Greater London zones 3-6, Tube-only stations outside London, zones saved', async () => {
  const tmp = tempProject();
  const naptan = [
    'ATCOCode,CommonName,Longitude,Latitude,StopType,Status',
    '9100HRPNDN,Harpenden Rail Station,-0.35148,51.81464,RLY,active',
    '9100BXLYHTH,Bexleyheath Rail Station,0.1337,51.4635,RLY,active', // London, zone 5
    '9100CLPHMJN,Clapham Junction Rail Station,-0.1703,51.4642,RLY,active', // London, zone 2
    '9100MYSTERY,Mystery Rail Station,-0.2,51.45,RLY,active', // London, TfL has no zone
  ].join('\n');
  const metro = (id, name, lat, lon, zone) => ({ naptanId: id, stopType: 'NaptanMetroStation', commonName: name, lat, lon,
    additionalProperties: [{ key: 'Zone', value: zone }] });
  const tube = [
    metro('940GZZLUEPG', 'Epping Underground Station', 51.6937, 0.1139, '6'), // Tube-only, outside Greater London
    metro('940GZZLUBKG', 'Barking Underground Station', 51.4392, 0.0810, '4'), // London, zone 4
    metro('940GZZLUBST', 'Baker Street Underground Station', 51.4229, -0.1570, '1'), // London, zone 1
    { naptanId: '940GZZLUEPG1', stopType: 'NaptanMetroPlatform', commonName: 'Epping', lat: 51.69, lon: 0.11 }, // not a station
  ];
  const zones = { '910GBXLYHTH': '5', '910GCLPHMJN': '2', '910GMYSTERY': null };
  const journeys = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('naptan.api.dft.gov.uk')) return { ok: true, status: 200, text: async () => naptan };
    if (u === 'https://api.postcodes.io/postcodes' && opts.method === 'POST') {
      const { geolocations } = JSON.parse(opts.body);
      return json({ status: 200, result: geolocations.map((g) => {
        const london = g.latitude < 51.5;
        return { query: g, result: [{ postcode: london ? 'DA6 7AA' : 'AL5 4FQ', region: london ? 'London' : 'East of England', country: 'England' }] };
      }) });
    }
    if (u.includes('api.tfl.gov.uk/StopPoint/Mode/tube')) return json({ stopPoints: tube });
    if (u.includes('api.tfl.gov.uk/StopPoint/Mode/dlr')) return json({ stopPoints: [] });
    const zm = u.match(/api\.tfl\.gov\.uk\/StopPoint\/(910G[A-Z]+)\?/);
    if (zm) return zones[zm[1]] === undefined ? json({}, 404) : json(stopZone(zm[1], zones[zm[1]]));
    if (u.includes('api.tfl.gov.uk/Journey')) {
      journeys.push(u);
      return json({ journeys: [{ duration: 40, legs: [
        { mode: { name: 'tube' }, duration: 30, departureTime: '2026-10-20T08:20:00', arrivalTime: '2026-10-20T08:50:00', routeOptions: [{ name: 'Central' }] },
      ] }] });
    }
    throw new Error('Unexpected URL in test: ' + u);
  };
  const { buildStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const lines = [];
  const out = await buildStations({ log: (m) => lines.push(m), gapMs: 0 });
  const by = Object.fromEntries(out.stations.map((s) => [s.name, s]));
  assert.deepEqual(Object.keys(by).sort(), ['Barking', 'Bexleyheath', 'Epping', 'Harpenden']);
  assert.deepEqual([by.Bexleyheath.london, by.Bexleyheath.zone], [true, '5']);
  assert.deepEqual([by.Barking.london, by.Barking.zone], [true, '4']);
  assert.deepEqual([by.Epping.london, by.Epping.zone], [false, '6'], 'Tube-only station outside Greater London');
  assert.deepEqual([by.Harpenden.london, by.Harpenden.zone], [false, null]);
  assert.ok(journeys.some((u) => u.includes('/JourneyResults/940GZZLUEPG/to/')), 'Tube stations planned by their TfL id');
  assert.ok(lines.some((l) => /1 London station.* no zone/.test(l)), lines.join('\n'));
});

test('station setup: a failed Tube list stops setup instead of saving a half-built list', async () => {
  const tmp = tempProject();
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    if (u.includes('naptan.api.dft.gov.uk')) return { ok: true, status: 200, text: async () => 'ATCOCode,CommonName,Longitude,Latitude,StopType,Status' };
    if (u.includes('api.tfl.gov.uk/StopPoint/Mode/')) return json({ message: 'bad' }, 400);
    throw new Error('Unexpected URL in test: ' + u);
  };
  const { buildStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  await assert.rejects(buildStations({ log: () => {}, gapMs: 0 }), /Tube/);
});

/* ───────── /api/find: stations plus their best likely Good+ schools ───────── */

const HARPENDEN = { id: '9100HRPNDN', name: 'Harpenden', lat: 51.81464, lng: -0.35148, postcode: 'AL5 4FQ', terminus: 'stpancras', trainMin: 27, changes: 0, changeAt: [] };
const school = (urn, name, phase, dLat, tone, extra = {}) => ({ urn, name, phase, lat: HARPENDEN.lat + dLat, lng: HARPENDEN.lng, ages: phase === 'Primary' ? '4–11' : '11–18', rating: { tone, headline: tone }, ...extra });
const FIND_SCHOOLS = { source: 'test', builtAt: '2026-10-01', schools: [
  school('1', 'Mixed Primary', 'Primary', 0.00135, 'mixed'), // 150 m, but only "mixed"
  school('2', 'Good Primary', 'Primary', 0.0027, 'good'), // 300 m
  school('3', 'St Mary RC', 'Secondary', -0.0027, 'great', { religion: 'Roman Catholic' }), // 300 m
] };
const STATIONS_FILE = { source: 'test', builtAt: '2026-10-17T10:00:00Z', journeyDate: '20261020', failed: 0, stations: [HARPENDEN] };

test('find: best likely Good+ school per phase from the station, faith respected', async () => {
  const tmp = tempProject({ 'schools.json': FIND_SCHOOLS, 'stations.json': STATIONS_FILE });
  const { findStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  let r = findStations(null);
  assert.equal(r.ready, true);
  assert.equal(r.journeyDate, '20261020');
  assert.equal(r.stations[0].primary.name, 'Good Primary');
  assert.equal(r.stations[0].secondary.name, 'St Mary RC');
  r = findStations('none'); // a Catholic school the family doesn't share is "unlikely"
  assert.equal(r.stations[0].secondary, null);
});

test('find: missing stations.json asks for setup', async () => {
  const tmp = tempProject({ 'schools.json': FIND_SCHOOLS });
  const { findStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const r = findStations(null);
  assert.equal(r.ready, false);
  assert.match(r.message, /npm run setup:stations/);
});

/* ───────── /api/find/price: one station's sales, EPC only when needed ───────── */

function priceMocks(flags) {
  globalThis.fetch = async (url) => {
    const u = String(url);
    if (u.includes('api.postcodes.io/postcodes?lat=')) {
      if (flags.postcodesDown) return json({ error: 'down' }, 500);
      // One sample point (the station itself) failing: a partial list must not be cached as complete.
      if (flags.centreDown && Number(new URL(u).searchParams.get('lat')) === HARPENDEN.lat) return json({ error: 'down' }, 400);
      return json({ result: [
        { postcode: 'AL5 1AA', latitude: HARPENDEN.lat + 0.001, longitude: HARPENDEN.lng, country: 'England' }, // ~110 m
        { postcode: 'AL5 2BB', latitude: HARPENDEN.lat + 0.0063, longitude: HARPENDEN.lng, country: 'England' }, // ~700 m
      ] });
    }
    if (u.includes('landregistry.data.gov.uk') && flags.many) {
      // 100 sales, one a week: only the 80 most recent should get room counts.
      const bindings = Array.from({ length: 100 }, (_, i) => ({ tx: { value: `tx-${i}` }, amount: { value: '700000' },
        date: { value: new Date(Date.UTC(2026, 5, 1) - i * 7 * 864e5).toISOString().slice(0, 10) },
        type: { value: 'http://landregistry.data.gov.uk/def/common/detached' }, paon: { value: String(i + 1) }, street: { value: 'HIGH STREET' },
        pc: { value: i < 50 ? 'AL5 1AA' : 'AL5 2BB' }, category: { value: 'http://landregistry.data.gov.uk/def/ppi/standardPricePaidTransaction' } }));
      return json({ results: { bindings } });
    }
    if (u.includes('landregistry.data.gov.uk')) {
      const b = (paon, pc, amount, type = 'detached') => ({ tx: { value: `tx-${paon}` }, amount: { value: String(amount) }, date: { value: '2026-05-01' },
        type: { value: `http://landregistry.data.gov.uk/def/common/${type}` }, paon: { value: paon }, street: { value: 'HIGH STREET' },
        pc: { value: pc }, category: { value: 'http://landregistry.data.gov.uk/def/ppi/standardPricePaidTransaction' } });
      return json({ results: { bindings: [
        b('1', 'AL5 1AA', 600000), b('2', 'AL5 1AA', 650000), b('3', 'AL5 1AA', 700000),
        b('4', 'AL5 1AA', 750000), b('5', 'AL5 1AA', 800000), b('6', 'AL5 2BB', 900000),
        b('7', 'AL5 1AA', 500000, 'terraced'), b('8', 'AL5 1AA', 400000, 'flat-maisonette'),
      ] } });
    }
    if (u.includes('get-energy-performance-data')) {
      flags.epcCalls++;
      flags.epcStarts?.push(Date.now());
      if (u.includes('/api/certificate')) flags.certCalls = (flags.certCalls || 0) + 1;
      if (flags.epcDown) return json({ error: 'down' }, 503);
      if (u.includes('/api/domestic/search')) {
        const pc = decodeURIComponent(new URL(u).searchParams.get('postcode')).replace('+', ' ');
        const paons = flags.many ? Array.from({ length: 100 }, (_, i) => String(i + 1)) : pc === 'AL5 1AA' ? ['1', '2', '3', '4', '5'] : ['6'];
        return json({ data: paons.map((p) => ({ certificateNumber: `C${p}`, addressLine1: `${p} HIGH STREET`, registrationDate: '2025-01-01' })) });
      }
      return json({ data: { habitable_room_count: 6, total_floor_area: 140 } });
    }
    throw new Error('Unexpected URL in test: ' + u);
  };
}

test('station price: distances attached, EPC skipped when everything is over budget', async () => {
  process.env.EPC_TOKEN = 'test';
  const flags = { epcCalls: 0 };
  priceMocks(flags);
  const tmp = tempProject({ 'stations.json': STATIONS_FILE });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const r = await stationPrice('9100HRPNDN', 300000);
  assert.equal(r.allSizesMedian, 725000);
  assert.equal(r.epc.enabled, true);
  assert.equal(r.epc.ran, false);
  assert.equal(flags.epcCalls, 0);
  assert.equal(r.sales.length, 6);
  assert.ok(r.sales.every((s) => Number.isFinite(s.distance)));
  assert.ok(r.sales.find((s) => s.price === 900000).distance > 600);
});

test('station price: terraced houses count in Greater London only', async () => {
  delete process.env.EPC_TOKEN;
  priceMocks({ epcCalls: 0 });
  const LONDON = { ...HARPENDEN, id: '9100BXLYHTH', name: 'Bexleyheath', london: true, zone: '5' };
  const tmp = tempProject({ 'stations.json': { ...STATIONS_FILE, stations: [HARPENDEN, LONDON] } });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const out = await stationPrice('9100HRPNDN', 900000);
  assert.deepEqual(out.sales.map((s) => s.type).sort(), Array(6).fill('Detached'));
  const lon = await stationPrice('9100BXLYHTH', 900000);
  assert.equal(lon.sales.length, 7, 'plus the terraced house, never the flat');
  assert.ok(lon.sales.some((s) => s.type === 'Terraced'));
  assert.equal(lon.terraced, true);
});

test('station price: EPC runs when the budget could pass, and an outage is flagged not cached', async () => {
  process.env.EPC_TOKEN = 'test';
  const flags = { epcCalls: 0, epcDown: true };
  priceMocks(flags);
  const tmp = tempProject({ 'stations.json': STATIONS_FILE });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const r = await stationPrice('9100HRPNDN', 900000);
  assert.equal(r.epc.ran, true);
  assert.match(r.epc.error, /isn't responding/);
  flags.epcDown = false;
  const again = await stationPrice('9100HRPNDN', 900000);
  assert.equal(again.epc.error, null);
  assert.equal(again.sales.filter((s) => s.rooms >= 5).length, 6);
});

test('station price: no postcodes is an error and is not cached', async () => {
  delete process.env.EPC_TOKEN;
  const flags = { epcCalls: 0, postcodesDown: true };
  priceMocks(flags);
  const tmp = tempProject({ 'stations.json': STATIONS_FILE });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  await assert.rejects(stationPrice('9100HRPNDN', 900000), /Couldn't look up postcodes/);
  flags.postcodesDown = false;
  const r = await stationPrice('9100HRPNDN', 900000);
  assert.equal(r.sales.length, 6);
  assert.equal(r.epc.enabled, false);
  await assert.rejects(stationPrice('NOPE', 900000), /Unknown station/);
});

test('station price: a partial postcode lookup is an error, not a thinner cached sample', async () => {
  delete process.env.EPC_TOKEN;
  const flags = { epcCalls: 0, centreDown: true };
  priceMocks(flags);
  const tmp = tempProject({ 'stations.json': STATIONS_FILE });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  await assert.rejects(stationPrice('9100HRPNDN', 900000), /Couldn't look up postcodes/);
  flags.centreDown = false;
  assert.equal((await stationPrice('9100HRPNDN', 900000)).sales.length, 6);
});

test('station price: room counts for the 80 most recent sales only, with EPC calls spaced out', async () => {
  process.env.EPC_TOKEN = 'test';
  process.env.FIND_EPC_GAP_MS = '20';
  const flags = { epcCalls: 0, many: true, epcStarts: [] };
  priceMocks(flags);
  const tmp = tempProject({ 'stations.json': STATIONS_FILE });
  const { stationPrice } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const r = await stationPrice('9100HRPNDN', 900000);
  delete process.env.FIND_EPC_GAP_MS;
  assert.equal(r.sales.length, 100);
  assert.equal(flags.certCalls, 80); // the EPC service rate-limits, so sample rather than check every sale
  assert.equal(r.sales.filter((s) => s.rooms != null).length, 80);
  assert.equal(r.sales.filter((s) => s.rooms != null).every((s) => s.date >= '2024-11-20'), true); // the most recent
  const gaps = flags.epcStarts.slice(1).map((t, i) => t - flags.epcStarts[i]);
  assert.ok(Math.min(...gaps) >= 15, `EPC calls ${Math.min(...gaps)} ms apart`);
});
