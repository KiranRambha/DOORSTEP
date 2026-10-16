// Flood risk: zip reading, CSV parsing and the area summary. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeZip } from './helpers.mjs';
import { readZipEntry } from '../lib/unzip.mjs';

test('zip reader finds a deflated entry by pattern, using the central directory', () => {
  const zip = makeZip([
    { name: 'X/DATA/', text: '', method: 0, date: new Date(2026, 5, 12) },
    { name: 'X/DATA/NaFRA2client.RoFRS_Postcodes_AtRisk.csv', text: 'PC,cntpc\nAB1 2CD,5\n', method: 8, date: new Date(2026, 5, 12) },
  ]);
  const e = readZipEntry(zip, /AtRisk\.csv$/);
  assert.equal(e.data.toString('utf8'), 'PC,cntpc\nAB1 2CD,5\n');
  assert.equal(e.modified, '2026-06-12');
  assert.equal(readZipEntry(zip, /nope/), null);
});

test('zip reader rejects something that is not a zip', () => {
  assert.throws(() => readZipEntry(Buffer.from('<html>error page</html>'), /csv/), /not a zip/i);
});
