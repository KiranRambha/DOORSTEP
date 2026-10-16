// Flood risk from the Environment Agency's "Risk of Flooding from Rivers and Sea –
// Postcodes in Areas at Risk". England only; an area estimate, not for a single house.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, cached, parseCsv, normalisePostcode } from './util.mjs';
import { postcodesAround } from './sources.mjs';

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

// "Higher risk" when this many homes nearby are at medium or high risk, or this share of
// nearby postcodes has any. No medium/high homes at all is "Low risk area"; anything else "Some risk".
export const FLOOD_THRESHOLDS = { higherHomes: 50, higherShare: 0.10 };
const LABELS = { low: 'Low risk area', some: 'Some risk', higher: 'Higher risk' };

/** Sum the at-risk homes for the postcodes around a point. Only English postcodes count (EA data). */
export function floodSummary(pcs, data) {
  const english = pcs.filter((p) => p.country !== 'Wales' && p.country !== 'Scotland');
  const homes = { high: 0, medium: 0, low: 0, veryLow: 0 };
  let postcodesAtRisk = 0, withMedHigh = 0, homesInAtRiskPostcodes = 0;
  for (const { postcode } of english) {
    const row = data.postcodes[postcode];
    if (!row) continue;
    const [res, high, medium, low, veryLow] = row;
    postcodesAtRisk++;
    homesInAtRiskPostcodes += res;
    homes.high += high; homes.medium += medium; homes.low += low; homes.veryLow += veryLow;
    if (high + medium > 0) withMedHigh++;
  }
  const medHigh = homes.high + homes.medium;
  const covered = english.length > 0 || pcs.length === 0;
  let verdict = null;
  if (covered) {
    verdict = medHigh === 0 ? 'low'
      : medHigh >= FLOOD_THRESHOLDS.higherHomes || withMedHigh / english.length >= FLOOD_THRESHOLDS.higherShare ? 'higher'
        : 'some';
  }
  return {
    covered,
    partial: covered && english.length < pcs.length,
    postcodesChecked: english.length,
    postcodesAtRisk,
    homes,
    homesInAtRiskPostcodes,
    medHigh,
    verdict,
    label: verdict ? LABELS[verdict] : 'No flood data for Wales',
  };
}

let floodCache = null;
function loadFlood() {
  if (floodCache) return floodCache;
  const file = path.join(DATA_DIR, 'flood.json');
  if (!fs.existsSync(file)) return null;
  floodCache = JSON.parse(fs.readFileSync(file, 'utf8'));
  return floodCache;
}

/** Flood risk within about 1 km of a point. */
export async function flood(lat, lng) {
  const data = loadFlood();
  if (!data) return { ready: false, message: 'Flood data isn\'t downloaded yet. Run "npm run setup:flood" in the project folder, then restart.' };
  // Cache only the postcode list, so a newer flood.json takes effect straight away.
  const pcs = await cached(`flood:v1:${lat.toFixed(4)},${lng.toFixed(4)}`, 24 * 30, async () => {
    const list = await postcodesAround(lat, lng, 1000, { dense: true });
    // Throwing here also stops an empty answer (postcodes.io down) from being cached.
    if (!list.length) throw new Error('Couldn\'t find any postcodes nearby to check for flood risk. Try again in a minute.');
    return list;
  });
  return { ready: true, source: data.source, fileDate: data.fileDate, ...floodSummary(pcs, data) };
}
