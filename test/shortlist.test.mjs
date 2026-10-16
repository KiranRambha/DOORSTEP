// Shortlist storage. Runs against a temp copy of the project so data/ is isolated.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorstep-sl-'));
fs.cpSync(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'public'));
fs.cpSync(path.join(root, 'public', 'snapshot.js'), path.join(tmp, 'public', 'snapshot.js'));
const tmpData = path.join(tmp, 'data');
fs.mkdirSync(tmpData);
const FILE = path.join(tmpData, 'shortlist.json');

const { loadShortlist, saveEntry, removeEntry } = await import(path.join(tmp, 'lib', 'shortlist.mjs'));
const { shortlistId } = await import(path.join(tmp, 'public', 'snapshot.js'));

const { isSafeWrite } = await import(path.join(tmp, 'lib', 'util.mjs'));

test('writes are only accepted as JSON from this app, so other websites cannot change saved data', () => {
  const h = (o) => ({ host: 'localhost:5173', ...o });
  assert.equal(isSafeWrite(h({ 'content-type': 'application/json' })), true);
  assert.equal(isSafeWrite(h({ 'content-type': 'application/json; charset=utf-8', origin: 'http://localhost:5173' })), true);
  assert.equal(isSafeWrite(h({ 'content-type': 'text/plain' })), false, 'a form or text/plain POST skips the CORS preflight');
  assert.equal(isSafeWrite(h({ 'content-type': 'application/json', origin: 'https://evil.example' })), false);
  assert.equal(isSafeWrite(h({ origin: 'http://localhost:5173' }), { body: false }), true, 'DELETE has no body');
  assert.equal(isSafeWrite(h({ origin: 'https://evil.example' }), { body: false }), false);
});

const place = (query, extra = {}) => ({ query, label: query, lat: 51.95, lng: -0.28, settings: {}, snapshot: {}, ...extra });

test('shortlist ids: postcodes normalise, place names lower-case', () => {
  assert.equal(shortlistId('sg51nz'), 'SG5 1NZ');
  assert.equal(shortlistId(' SG5  1NZ '), 'SG5 1NZ');
  assert.equal(shortlistId('  Hitchin   Town '), 'hitchin town');
});

test('shortlist: save, update by id, remove', () => {
  fs.rmSync(FILE, { force: true });
  assert.deepEqual(loadShortlist(), []);
  const a = saveEntry(place('sg51nz'));
  assert.equal(a.id, 'SG5 1NZ');
  const b = saveEntry(place('SG5 1NZ', { snapshot: { crime: { perMonth: 9 } } }));
  assert.equal(loadShortlist().length, 1, 'same place saved twice is one entry');
  assert.equal(b.savedAt, a.savedAt);
  assert.equal(loadShortlist()[0].snapshot.crime.perMonth, 9);
  assert.equal(removeEntry('SG5 1NZ'), true);
  assert.equal(removeEntry('SG5 1NZ'), false);
  assert.deepEqual(loadShortlist(), []);
});

test('shortlist: a damaged file is never overwritten', () => {
  fs.writeFileSync(FILE, '{ not json');
  assert.throws(() => loadShortlist(), /damaged/);
  assert.throws(() => saveEntry(place('Hitchin')), /damaged/);
  assert.throws(() => removeEntry('hitchin'), /damaged/);
  assert.equal(fs.readFileSync(FILE, 'utf8'), '{ not json');
  fs.rmSync(FILE);
});

test('shortlist: a refresh never brings back a removed place', () => {
  fs.rmSync(FILE, { force: true });
  assert.throws(() => saveEntry(place('Hitchin'), { mustExist: true }), /no longer on your shortlist/);
  assert.deepEqual(loadShortlist(), []);
  saveEntry(place('Hitchin'));
  assert.equal(saveEntry(place('Hitchin', { snapshot: { crime: { perMonth: 3 } } }), { mustExist: true }).snapshot.crime.perMonth, 3);
  fs.rmSync(FILE);
});

test('shortlist: an unreadable file is an error, not an empty list', () => {
  fs.mkdirSync(FILE); // reading a directory fails with EISDIR
  assert.throws(() => loadShortlist(), /couldn't be read|damaged/i);
  assert.throws(() => saveEntry(place('Hitchin')));
  assert.ok(fs.statSync(FILE).isDirectory(), 'left alone');
  fs.rmSync(FILE, { recursive: true });
});

test('shortlist: bad entries are rejected', () => {
  assert.throws(() => saveEntry(place('')), /place/i);
  assert.throws(() => saveEntry(place('x', { lat: 10 })), /England or Wales/);
  assert.throws(() => saveEntry(place('x', { snapshot: 'nope' })), /snapshot/i);
});

/* ───────────── Snapshot builder (public/snapshot.js) ───────────── */

const snap = await import(path.join(root, 'public', 'snapshot.js'));
const settings = { dest: 'bank', faith: 'none', hideFaith: false, schoolRadius: 3000, priceRadius: 1000, priceYears: 3, priceSize: 0 };
const school = (name, phase, distance, estimate, extra = {}) => ({
  name, phase, distance, religion: 'Does not apply', rating: { tone: 'great' },
  catchment: { estimate, status: estimate, label: estimate === 'likely' ? 'Likely' : 'Unlikely · may take others if not full' }, ...extra,
});
const sources = (over = {}) => ({
  transport: { destination: 'Bank (City of London)', doorToDoor: { minutes: 64, changes: 1 }, stations: [{ name: 'Hitchin', distance: 600 }] },
  schools: { ready: true, schools: [
    school('St Mary RC', 'Primary', 300, 'unlikely', { religion: 'Roman Catholic' }),
    school('Oak', 'Primary', 900, 'likely'),
    school('Good Sec', 'Secondary', 500, 'likely', { rating: { tone: 'good' } }),
  ] },
  prices: { epc: { enabled: false }, sales: [
    { type: 'Detached', price: 800000 }, { type: 'Detached', price: 900000 },
    { type: 'Semi-detached', price: 500000 },
  ] },
  crime: { total: 120, monthsCounted: 12, previous: { total: 100 } },
  flood: { ready: true, covered: true, medHigh: 3, verdict: 'some', label: 'Some risk' },
  ...over,
});

test('walk time is distance at 80 m a minute, rounded up', () => {
  assert.equal(snap.walkMinutes(600), 8);
  assert.equal(snap.walkMinutes(0), 0);
  assert.equal(snap.walkMinutes(81), 2);
});

test('snapshot: nearest Outstanding school you would likely get into', () => {
  const s = snap.buildSnapshot(sources(), settings, new Date('2026-10-16T10:00:00Z'));
  assert.equal(s.schools.primary.name, 'Oak');
  assert.equal(s.schools.primary.likely, true);
  assert.equal(s.schools.secondary, null, 'a Good school is not Outstanding');
  assert.equal(s.transport.station.walkMin, 8);
  assert.equal(s.transport.door.minutes, 64);
  assert.equal(s.prices.detached.median, 850000);
  assert.equal(s.prices.semi.count, 1);
  assert.equal(s.crime.perMonth, 10);
  assert.equal(s.crime.trendPct, 20);
  assert.equal(s.flood.verdict, 'some');
  assert.equal(s.crime.asOf, '2026-10-16');
});

test('snapshot: falls back to the nearest Outstanding school when none is likely', () => {
  const only = sources({ schools: { ready: true, schools: [school('St Mary RC', 'Primary', 300, 'unlikely', { religion: 'Roman Catholic' })] } });
  const s = snap.buildSnapshot(only, settings);
  assert.equal(s.schools.primary.name, 'St Mary RC');
  assert.equal(s.schools.primary.likely, false);
  assert.equal(snap.buildSnapshot(only, { ...settings, hideFaith: true }).schools.primary, null, 'hidden faith schools are ignored');
  const far = sources({ schools: { ready: true, schools: [school('Oak', 'Primary', 4000, 'likely')] } });
  assert.equal(snap.buildSnapshot(far, settings).schools.primary, null, 'outside the school radius');
});

test('snapshot: missing or failed sections become null without throwing', () => {
  const s = snap.buildSnapshot(sources({ transport: null, prices: { error: 'x' }, flood: { ready: false, message: 'run setup' }, schools: { ready: false } }), settings);
  assert.equal(s.transport, null);
  assert.equal(s.prices, null);
  assert.equal(s.flood, null);
  assert.equal(s.schools, null);
  assert.equal(s.crime.perMonth, 10);
});

test('snapshot: the room filter only applies when EPC data is on', () => {
  const p = { epc: { enabled: true }, sales: [{ type: 'Detached', price: 1, habitableRooms: 4 }, { type: 'Detached', price: 3, habitableRooms: 7 }] };
  assert.equal(snap.buildSnapshot(sources({ prices: p }), { ...settings, priceSize: 6 }).prices.detached.median, 3);
  assert.equal(snap.buildSnapshot(sources({ prices: { ...p, epc: { enabled: false } } }), { ...settings, priceSize: 6 }).prices.detached.median, 2);
});

test('refresh keeps the old value for a section that failed', () => {
  const old = { crime: { perMonth: 9, asOf: '2026-10-12' }, transport: { asOf: '2026-10-12', door: { minutes: 70 } } };
  const fresh = { crime: null, transport: { asOf: '2026-10-16', door: { minutes: 64 } } };
  const m = snap.mergeSnapshot(old, fresh);
  assert.equal(m.crime.perMonth, 9);
  assert.equal(m.crime.asOf, '2026-10-12');
  assert.equal(m.transport.door.minutes, 64);
});

test('best in each column: ties all shade, single values and unlikely schools never do', () => {
  const e = (id, s) => ({ id, snapshot: s });
  const best = snap.bestInColumn([
    e('a', { transport: { door: { minutes: 50 }, station: { walkMin: 5 } }, schools: { primary: { distance: 900, likely: false } }, crime: { perMonth: 10 } }),
    e('b', { transport: { door: { minutes: 50 }, station: { walkMin: 9 } }, schools: { primary: { distance: 1200, likely: true } }, crime: null }),
    e('c', { transport: { door: { minutes: 60 }, station: null }, schools: { primary: { distance: 1500, likely: true } }, crime: null }),
  ]);
  assert.deepEqual(best.door, ['a', 'b']);
  assert.deepEqual(best.walk, ['a']);
  assert.deepEqual(best.primary, ['b']);
  assert.deepEqual(best.crime, [], 'only one row has a value');
});

test('faith label for the school cells', () => {
  assert.equal(snap.faithLabel({ faith: 'none' }), 'faith: no faith');
  assert.equal(snap.faithLabel({ faith: 'catholic', hideFaith: true }), 'faith: Catholic · faith schools hidden');
  assert.equal(snap.faithLabel({}), 'faith: not set');
  assert.equal(snap.faithLabel({ faith: '' }), 'faith: not set');
});

test('rows saved with different faith settings are flagged', () => {
  const e = (faith, hideFaith = false) => ({ settings: { faith, hideFaith } });
  assert.equal(snap.faithSettingsDiffer([e('none'), e('none')]), false);
  assert.equal(snap.faithSettingsDiffer([e('none'), e('catholic')]), true);
  assert.equal(snap.faithSettingsDiffer([e('none'), e('none', true)]), true);
  assert.equal(snap.faithSettingsDiffer([e(''), { settings: {} }]), false, 'missing means not set');
  assert.equal(snap.faithSettingsDiffer([e('none')]), false);
});

test('refreshing with new settings never keeps old settings-dependent values', () => {
  const old = { schools: { asOf: '2026-10-12', primary: { name: 'Old pick' } }, prices: { asOf: '2026-10-12' }, transport: { asOf: '2026-10-12' }, crime: { perMonth: 9, asOf: '2026-10-12' }, flood: { medHigh: 3, asOf: '2026-10-12' } };
  const fresh = { schools: null, prices: null, transport: null, crime: null, flood: null };
  const m = snap.mergeSnapshot(old, fresh, { settingsChanged: true });
  assert.equal(m.schools, null, 'a school pick made under the old faith setting would be wrong');
  assert.equal(m.prices, null);
  assert.equal(m.transport, null);
  assert.equal(m.crime.perMonth, 9, 'crime and flood do not depend on settings');
  assert.equal(m.flood.medHigh, 3);
});
