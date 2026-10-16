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
