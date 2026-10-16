// The owner's saved shortlist, in data/shortlist.json. Never delete or blank this file.
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.mjs';
import { shortlistId } from '../public/snapshot.js';

const FILE = path.join(DATA_DIR, 'shortlist.json');
const MAX_ENTRIES = 100;
const bad = (msg) => Object.assign(new Error(msg), { status: 400 });

/** All saved places, oldest first. Throws (rather than starting afresh) if the file is damaged. */
export function loadShortlist() {
  let raw;
  try { raw = fs.readFileSync(FILE, 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return [];
    throw Object.assign(new Error(`The shortlist file (data/shortlist.json) couldn't be read (${e.code}), so it hasn't been changed.`), { status: 500 });
  }
  try {
    const list = JSON.parse(raw);
    if (!Array.isArray(list)) throw new Error('not a list');
    return list;
  } catch {
    throw Object.assign(new Error('The shortlist file (data/shortlist.json) is damaged, so it hasn\'t been changed. Fix or move it, then try again.'), { status: 500 });
  }
}

function write(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE + '.tmp', JSON.stringify(list, null, 2));
  fs.renameSync(FILE + '.tmp', FILE);
}

/** Add a place, or replace the entry with the same id (keeping when it was first saved).
 *  `mustExist` (used by refresh) never re-adds a place that was removed meanwhile. */
export function saveEntry(e, { mustExist = false } = {}) {
  const id = shortlistId(e?.query);
  if (!id) throw bad('Which place? The entry needs the search it came from.');
  const lat = Number(e.lat), lng = Number(e.lng);
  if (!(lat >= 49 && lat <= 56 && lng >= -7 && lng <= 2.5)) throw bad('The place must be in England or Wales.');
  if (!e.snapshot || typeof e.snapshot !== 'object' || Array.isArray(e.snapshot)) throw bad('The entry has no snapshot.');

  const list = loadShortlist();
  const old = list.find((x) => x.id === id);
  if (mustExist && !old) throw Object.assign(new Error('That place is no longer on your shortlist.'), { status: 404 });
  const now = new Date().toISOString();
  const entry = {
    id,
    query: String(e.query).trim().slice(0, 100),
    label: String(e.label || e.query).slice(0, 100),
    area: e.area ? String(e.area).slice(0, 200) : '',
    lat, lng,
    country: e.country || null,
    savedAt: old?.savedAt || now,
    refreshedAt: now,
    settings: e.settings && typeof e.settings === 'object' ? e.settings : {},
    snapshot: e.snapshot,
  };
  if (old) list[list.indexOf(old)] = entry;
  else {
    if (list.length >= MAX_ENTRIES) throw bad(`The shortlist is full (${MAX_ENTRIES} places). Remove some first.`);
    list.push(entry);
  }
  write(list);
  return entry;
}

export function removeEntry(id) {
  const list = loadShortlist();
  const next = list.filter((x) => x.id !== id);
  if (next.length === list.length) return false;
  write(next);
  return true;
}
