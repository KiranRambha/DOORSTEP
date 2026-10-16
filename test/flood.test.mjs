// Flood risk: zip reading, CSV parsing and the area summary. Offline.
import test from 'node:test';
import assert from 'node:assert/strict';

import { makeZip } from './helpers.mjs';
import { readZipEntry } from '../lib/unzip.mjs';
import { parseFloodCsv, floodSummary } from '../lib/flood.mjs';

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

test('flood summary counts English postcodes and picks a verdict', () => {
  const data = { postcodes: { 'TN9 1RD': [20, 4, 3, 2, 1], 'TN9 1RE': [10, 0, 0, 5, 0] } };
  const pcs = [{ postcode: 'TN9 1RD', country: 'England' }, { postcode: 'TN9 1RE', country: 'England' }, { postcode: 'TN9 1RF', country: 'England' }];
  const s = floodSummary(pcs, data);
  assert.deepEqual(s.homes, { high: 4, medium: 3, low: 7, veryLow: 1 });
  assert.equal(s.medHigh, 7);
  assert.equal(s.postcodesChecked, 3);
  assert.equal(s.postcodesAtRisk, 2);
  assert.equal(s.homesInAtRiskPostcodes, 30);
  assert.equal(s.verdict, 'higher'); // 1 of 3 postcodes (33%) has medium/high homes, which is at least 10%
  assert.equal(s.label, 'Higher risk');
  const none = floodSummary([{ postcode: 'TN9 1RF', country: 'England' }], data);
  assert.equal(none.verdict, 'low');
  assert.equal(none.label, 'Low risk area');
});

test('flood summary: "some risk" when a few homes are at risk across many postcodes', () => {
  const postcodes = { 'AB1 1AA': [10, 0, 2, 0, 0] };
  const pcs = Array.from({ length: 20 }, (_, i) => ({ postcode: i ? `AB1 1A${String.fromCharCode(65 + i)}` : 'AB1 1AA', country: 'England' }));
  assert.equal(floodSummary(pcs, { postcodes }).verdict, 'some'); // 1 of 20 = 5%, 2 homes
});

test('flood summary: Wales is not covered, border areas are partial', () => {
  const data = { postcodes: {} };
  const wales = floodSummary([{ postcode: 'CF10 1AA', country: 'Wales' }], data);
  assert.equal(wales.covered, false);
  assert.equal(wales.verdict, null);
  assert.equal(wales.label, 'No flood data for Wales');
  const border = floodSummary([{ postcode: 'CF10 1AA', country: 'Wales' }, { postcode: 'HR1 1AA', country: 'England' }], data);
  assert.equal(border.covered, true);
  assert.equal(border.partial, true);
  assert.equal(border.postcodesChecked, 1);
});

test('flood summary: a Welsh place near the border is not covered, even with English postcodes nearby', () => {
  const data = { postcodes: { 'HR1 1AA': [5, 0, 0, 0, 0] } };
  const s = floodSummary([
    { postcode: 'NP16 5AA', country: 'Wales', distance: 40 },
    { postcode: 'HR1 1AA', country: 'England', distance: 800 },
  ], data);
  assert.equal(s.covered, false);
  assert.equal(s.label, 'No flood data for Wales');
  const eng = floodSummary([
    { postcode: 'HR1 1AA', country: 'England', distance: 40 },
    { postcode: 'NP16 5AA', country: 'Wales', distance: 800 },
  ], data);
  assert.equal(eng.covered, true);
  assert.equal(eng.partial, true);
});
