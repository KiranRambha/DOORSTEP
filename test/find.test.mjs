// Find places: the pure rules, the station setup and the two API helpers. Offline; every API is mocked.
import test from 'node:test';
import assert from 'node:assert/strict';

import { walkAllowance, priceVerdict, rankStations } from '../public/find.js';

/* ───────── Pure rules ───────── */

test('walk allowance shrinks with the train and drops under 5 minutes', () => {
  assert.equal(walkAllowance(40, { maxDoor: 60, maxWalk: 15 }), 15);
  assert.equal(walkAllowance(50, { maxDoor: 60, maxWalk: 15 }), 10);
  assert.equal(walkAllowance(55, { maxDoor: 60, maxWalk: 15 }), 5);
  assert.equal(walkAllowance(56, { maxDoor: 60, maxWalk: 15 }), null);
  assert.equal(walkAllowance(null, {}), null);
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

const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });

const NAPTAN = [
  'ATCOCode,CommonName,Longitude,Latitude,StopType,Status',
  '9100HRPNDN,Harpenden Rail Station,-0.35148,51.81464,RLY,active',
  '9100CLPHMJN,Clapham Junction Rail Station,-0.1703,51.4642,RLY,active',
  '9100NRCH,Norwich Rail Station,1.3069,52.6273,RLY,active',
  '9100NOWHERE,Nowhere Rail Station,-0.2,51.9,RLY,active',
  '9100OLDSTN,Old Station Rail Station,-0.3,51.7,RLY,inactive',
].join('\n');

test('station setup: outside London only, fastest terminus, resume uses the cache', async () => {
  const tmp = tempProject();
  let tflCalls = 0;
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
    if (u.includes('api.tfl.gov.uk/Journey')) {
      tflCalls++;
      if (u.includes('/51.9,')) return json({ journeys: [] });
      return json({ journeys: [{ duration: 27, startDateTime: '2026-10-20T08:33:00', arrivalDateTime: '2026-10-20T09:00:00', legs: [
        { mode: { name: 'national-rail' }, duration: 27, instruction: { summary: 'Thameslink' }, routeOptions: [{ name: 'Thameslink' }] },
      ] }] });
    }
    throw new Error('Unexpected URL in test: ' + u);
  };
  const { buildStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const { TERMINI } = await import(path.join(tmp, 'lib', 'sources.mjs'));
  const out = await buildStations({ log: () => {} });
  assert.deepEqual(out.stations.map((s) => s.name), ['Harpenden']);
  const h = out.stations[0];
  assert.equal(h.trainMin, 27);
  assert.equal(h.postcode, 'AL5 4FQ');
  assert.ok(TERMINI.includes(h.terminus));
  assert.equal(TERMINI.length, 16);
  assert.equal(out.failed, 1); // Nowhere: no journey
  assert.equal(tflCalls, 6); // 3 termini each for Harpenden and Nowhere
  tflCalls = 0;
  await buildStations({ log: () => {} });
  assert.equal(tflCalls, 3); // Harpenden cached; Nowhere's empty result retried
});
