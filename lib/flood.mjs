// Flood risk from the Environment Agency's "Risk of Flooding from Rivers and Sea –
// Postcodes in Areas at Risk". England only; an area estimate, not for a single house.
import { parseCsv, normalisePostcode } from './util.mjs';

const COLUMNS = ['RES_cntpc', 'RES_CNT_High', 'RES_CNT_Medium', 'RES_CNT_Low', 'RES_CNT_VeryLow'];

/** CSV text -> { postcode: [homes, high, medium, low, veryLow] } (residential counts). */
export function parseFloodCsv(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const pcCol = header.indexOf('PC');
  const cols = COLUMNS.map((c) => header.indexOf(c));
  if (pcCol < 0 || cols.includes(-1)) throw new Error('The flood CSV is missing expected columns.');
  const out = {};
  for (const r of rows) {
    const pc = normalisePostcode(r[pcCol]);
    if (pc) out[pc] = cols.map((i) => Number(r[i]) || 0);
  }
  return out;
}
