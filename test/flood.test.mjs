// Flood risk: zip reading, CSV parsing and the area summary. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeZip } from './helpers.mjs';
import { readZipEntry } from '../lib/unzip.mjs';
import { parseFloodCsv } from '../lib/flood.mjs';

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

test('flood CSV parses residential counts per postcode and strips the BOM', () => {
  const csv = '\uFEFFPC,cntpc,RES_cntpc,NRP_cntpc,UNC_cntpc,RES_CNT_VeryLow,NRP_CNT_VeryLow,UNC_CNT_VeryLow,TOT_CNT_VeryLow,RES_CNT_Low,NRP_CNT_Low,UNC_CNT_Low,TOT_CNT_Low,RES_CNT_Medium,NRP_CNT_Medium,UNC_CNT_Medium,TOT_CNT_Medium,RES_CNT_High,NRP_CNT_High,UNC_CNT_High,TOT_CNT_High,SORTOFF,DISTRICT,SECTOR,UNIT\r\n'
    + 'WF13 2HF,15,4,7,4,0,0,0,0,4,7,2,13,0,0,1,1,0,0,1,1,WF,13,2,HF\r\n'
    + 'tn91rd,30,20,5,5,1,0,0,1,2,0,0,2,3,0,0,3,4,0,0,4,TN,9,1,RD\r\n'
    // Grouped "no risk" rows and non-postcode codes are skipped.
    + 'TW9 4H*,299,273,25,1,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,TW,9,4,H\r\n'
    + 'VPO01148,1,0,1,0,0,0,0,0,0,1,0,1,0,0,0,0,0,0,0,0,,,,\r\n';
  assert.deepEqual(parseFloodCsv(csv), { 'WF13 2HF': [4, 0, 0, 4, 0], 'TN9 1RD': [20, 4, 3, 2, 1] });
});
