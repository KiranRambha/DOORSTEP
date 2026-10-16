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

test('shortlist: bad entries are rejected', () => {
  assert.throws(() => saveEntry(place('')), /place/i);
  assert.throws(() => saveEntry(place('x', { lat: 10 })), /England or Wales/);
  assert.throws(() => saveEntry(place('x', { snapshot: 'nope' })), /snapshot/i);
});
