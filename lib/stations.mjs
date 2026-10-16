// Find places: the station list (built once by `npm run setup:stations`) and the per-search lookups.
import { fetchJson, cached, mapLimit, distanceM, parseCsv } from './util.mjs';
import { DESTINATIONS, TERMINI, journey, nextTuesday } from './sources.mjs';

const NAPTAN_URL = 'https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910';
export const NAPTAN_SOURCE = 'NaPTAN rail stations (Department for Transport)';
export const MAX_TRAIN_MIN = 85; // the largest door-to-door setting (90) minus the minimum walk (5)
export const PREFILTER_KM = 100; // from Charing Cross: nothing further out makes 85 minutes
const TRIES_PER_STATION = 3; // nearest termini by straight line

/** NaPTAN CSV text -> active rail stations [{ id, name, lat, lng }]. */
export function parseNaptanRail(text) {
  const [header, ...rows] = parseCsv(text.replace(/^﻿/, ''));
  const col = (name) => header.indexOf(name);
  const [id, name, lat, lng, type, status] = ['ATCOCode', 'CommonName', 'Latitude', 'Longitude', 'StopType', 'Status'].map(col);
  if ([id, name, lat, lng, type].includes(-1)) throw new Error('The NaPTAN file is missing expected columns.');
  return rows
    .filter((r) => r[type] === 'RLY' && (status < 0 || r[status] === 'active'))
    .map((r) => ({ id: r[id], name: r[name].replace(/ Rail Station$/, ''), lat: Number(r[lat]), lng: Number(r[lng]) }))
    .filter((s) => Number.isFinite(s.lat) && Number.isFinite(s.lng));
}

/** Nearest postcode, region and country for each point (postcodes.io bulk reverse geocode). */
async function reverseGeocode(points, radius) {
  const out = [];
  for (let i = 0; i < points.length; i += 100) {
    const chunk = points.slice(i, i + 100);
    const r = await fetchJson('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ geolocations: chunk.map((p) => ({ latitude: p.lat, longitude: p.lng, limit: 1, radius })) }),
    });
    for (const item of r.result || []) out.push(item.result?.[0] || null);
  }
  return out;
}

/** Fastest trip from a station to the nearest few termini. Each journey is cached, so a re-run resumes. */
async function bestTrip(station, date) {
  const keys = [...TERMINI]
    .sort((a, b) => distanceM(station.lat, station.lng, DESTINATIONS[a].lat, DESTINATIONS[a].lng)
      - distanceM(station.lat, station.lng, DESTINATIONS[b].lat, DESTINATIONS[b].lng))
    .slice(0, TRIES_PER_STATION);
  const trips = await Promise.all(keys.map((key) =>
    cached(`stjourney:v1:${station.id}:${key}:${date}`, 24 * 30, async () => {
      const j = await journey(station, DESTINATIONS[key], date);
      // Throwing keeps "no journey" out of the cache, so the next run tries again.
      if (!j) throw new Error('No journey found');
      return { terminus: key, minutes: j.minutes, changes: j.changes, changeAt: j.changeAt };
    }).catch(() => null)));
  return trips.filter(Boolean).sort((a, b) => a.minutes - b.minutes)[0] || null;
}

/** Build the station list: rail stations in England outside Greater London, with their fastest
 *  9am weekday trip into a central terminus. */
export async function buildStations({ log = console.log } = {}) {
  log('Downloading the NaPTAN rail station list…');
  const res = await fetch(NAPTAN_URL, { headers: { 'User-Agent': 'Doorstep/0.1 (personal home-search tool)' } });
  if (!res.ok) throw new Error(`NaPTAN download failed: ${res.status}`);
  const cx = DESTINATIONS.charingx;
  let stations = parseNaptanRail(await res.text())
    .filter((s) => distanceM(cx.lat, cx.lng, s.lat, s.lng) <= PREFILTER_KM * 1000);
  log(`${stations.length} rail stations within ${PREFILTER_KM} km of central London.`);

  // Nearest postcode (to open the place later) and region (to leave out Greater London).
  const near = await reverseGeocode(stations, 1000);
  const missing = stations.filter((_, i) => !near[i]);
  if (missing.length) {
    const wider = await reverseGeocode(missing, 2000);
    missing.forEach((s, i) => { near[stations.indexOf(s)] = wider[i]; });
  }
  let noPostcode = 0;
  stations = stations.flatMap((s, i) => {
    const p = near[i];
    if (!p) { noPostcode++; return []; }
    if (p.region === 'London' || p.country !== 'England') return [];
    return [{ ...s, postcode: p.postcode }];
  });
  log(`${stations.length} outside Greater London${noPostcode ? ` (${noPostcode} skipped: no postcode nearby)` : ''}. Planning journeys…`);

  const date = nextTuesday();
  let done = 0;
  const planned = await mapLimit(stations, 4, async (s) => {
    const trip = await bestTrip(s, date);
    if (++done % 25 === 0) log(`Planned ${done} of ${stations.length} stations…`);
    return { ...s, terminus: trip?.terminus ?? null, trainMin: trip?.minutes ?? null, changes: trip?.changes ?? null, changeAt: trip?.changeAt ?? [] };
  });

  return {
    source: NAPTAN_SOURCE,
    builtAt: new Date().toISOString(),
    journeyDate: date,
    failed: planned.filter((s) => s.trainMin == null).length,
    stations: planned.filter((s) => s.trainMin != null && s.trainMin <= MAX_TRAIN_MIN),
  };
}
