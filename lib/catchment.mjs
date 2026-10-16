// Catchment guide.
//
// There is no national catchment dataset for England. Most community and academy
// schools that are oversubscribed admit by straight-line distance after siblings and
// looked-after children, and councils publish the "last distance offered" each year
// (often called the furthest distance or cut-off distance) in their allocation reports.
//
// So this does two things:
//  1. Estimates your chances from how close you are and how many other schools of the
//     same phase are closer. This is a rough guide only.
//  2. Lets you enter a school's real last distance offered. When you do, the guide
//     uses that instead and tells you whether you're inside it.

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './util.mjs';

const FILE = path.join(DATA_DIR, 'catchment.json');

export function loadOverrides() {
  try { return JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { return {}; }
}

export function saveOverride(urn, metres, note) {
  const all = loadOverrides();
  if (metres == null) delete all[urn];
  else all[urn] = { metres: Math.round(metres), note: note ? String(note).slice(0, 120) : null, savedAt: new Date().toISOString().slice(0, 10) };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(all, null, 2));
  return all[urn] || null;
}

const NO_FAITH = new Set([null, undefined, '', 'Does not apply', 'None', 'Unknown']);

// Distance bands for the estimate, in metres.
const BANDS = {
  Primary: { sure: 400, nearest: 1000, possible: 1500 },
  Secondary: { sure: 1000, nearest: 3000, possible: 4500 },
};

/* ── Faith ──
 * Strict faiths usually give most places to practising families when oversubscribed.
 * Church of England and other Christian schools often keep many open places, so they
 * stay distance-based with a softer note. */
export const FAITH_OPTIONS = ['none', 'coe', 'catholic', 'christian', 'jewish', 'muslim', 'hindu', 'sikh'];
const STRICT = new Set(['catholic', 'jewish', 'muslim', 'hindu', 'sikh']);
const FAITH_SHORT = { coe: 'Church of England', catholic: 'Catholic', christian: 'Christian', jewish: 'Jewish', muslim: 'Muslim', hindu: 'Hindu', sikh: 'Sikh', multi: 'multi-faith' };

/** Which faith groups a school's designated religious character belongs to. */
export function faithGroups(religion) {
  const r = String(religion || '').toLowerCase();
  const g = new Set();
  if (NO_FAITH.has(religion) || !r) return g;
  if (/church of england|anglican/.test(r)) g.add('coe');
  if (/catholic/.test(r)) g.add('catholic');
  if (/jewish/.test(r)) g.add('jewish');
  if (/muslim|islam/.test(r)) g.add('muslim');
  if (/hindu/.test(r)) g.add('hindu');
  if (/sikh/.test(r)) g.add('sikh');
  if (/multi|inter/.test(r)) g.add('multi');
  if (/christian|methodist|reform|baptist|free church|quaker|orthodox|adventist/.test(r) && !g.has('jewish')) g.add('christian');
  if (!g.size) g.add('christian');
  return g;
}

/** A strict faith school the family doesn't share, so distance alone won't get a place. */
function outOfReachFaith(s, faith) {
  if (!faith) return false;
  const g = faithGroups(s.religion);
  if (!g.size || g.has(faith)) return false;
  return [...g].every((x) => STRICT.has(x));
}

const group = (phase) => (phase === 'Primary' ? 'Primary' : phase === 'Secondary' ? 'Secondary' : null);

/**
 * Adds `catchment` to each school.
 * `schools` must include every school near the home (not just the ones displayed)
 * and carry `distance` in metres from the home.
 *
 * catchment = { status, label, detail, official }
 *   status: 'in' | 'likely' | 'possible' | 'unlikely' | 'out' | 'faith' | 'selective' | 'special' | 'na'
 */
/** Age at which children join: infants/primaries 4, juniors 7, middle 9, secondary 11, upper 13. */
export function entryAge(s) {
  const lo = Number(String(s.ages || '').split(/[–-]/)[0]);
  if (!lo) return s.phase === 'Secondary' ? 11 : 4;
  if (lo <= 5) return 4;          // nursery or reception intake
  if (lo <= 8) return 7;          // junior
  if (lo <= 10) return 9;         // middle
  return lo <= 12 ? 11 : 13;      // secondary / upper
}

/** Single-sex schools, guessed from the name (Ofsted's file doesn't record it). */
export function sexOf(s) {
  const n = s.name || '';
  if (/\bgirls'?\b|\bladies'?\b/i.test(n)) return 'girls';
  if (/\bboys'?\b/i.test(n)) return 'boys';
  return null;
}

/** How many schools a child joining this one could also join are closer, plus one. */
function rankOf(s, pool, faith) {
  const age = entryAge(s);
  const sex = sexOf(s);
  const opposite = sex === 'boys' ? 'girls' : sex === 'girls' ? 'boys' : null;
  let closer = 0;
  for (const o of pool) {
    if (o === s || o.distance >= s.distance) continue;
    if (group(o.phase) !== group(s.phase) || entryAge(o) !== age) continue;
    if (opposite && sexOf(o) === opposite) continue;
    if (o.admissions === 'Selective') continue;
    if (outOfReachFaith(o, faith)) continue;
    closer++;
  }
  return closer + 1;
}

export function addCatchment(schools, overrides = loadOverrides(), { faith = null } = {}) {
  if (!FAITH_OPTIONS.includes(faith)) faith = null;
  for (const s of schools) {
    const o = overrides[s.urn];
    const g = group(s.phase);
    const r = g ? rankOf(s, schools, faith) : null;

    if (o) {
      const margin = o.metres - s.distance;
      const close = Math.abs(margin) < 100;
      s.catchment = margin >= 0
        ? { status: close ? 'possible' : 'in', label: close ? 'Borderline' : 'Inside last offer', official: true }
        : { status: close ? 'possible' : 'out', label: close ? 'Borderline' : 'Outside last offer', official: true };
      s.catchment.detail = `You're about ${fmt(s.distance)} away; the last place offered went to ${fmt(o.metres)}${o.note ? ` (${o.note})` : ''}.`
        + (close ? ' That\'s within the margin of error, so check the council\'s own measurement.' : '');
      s.catchment.lastOffered = o.metres;
      s.catchment.note = o.note;
      continue;
    }

    if (s.phase === 'Special' || s.phase === 'Alternative provision') {
      s.catchment = { status: 'special', label: 'By referral', detail: 'Places are arranged through the council, usually with an EHC plan, not by distance.', official: false };
      continue;
    }
    if (!g) {
      s.catchment = { status: 'na', label: '–', detail: 'Nursery places don\'t use catchment in the usual way.', official: false };
      continue;
    }
    if (s.admissions === 'Selective') {
      s.catchment = { status: 'selective', label: 'Entrance test', detail: 'A grammar school: places depend on the 11+ result first, then usually distance.', official: false };
      continue;
    }

    const b = BANDS[g];
    let status;
    if (s.distance <= b.sure || (r === 1 && s.distance <= b.nearest)) status = 'likely';
    else if (r <= 3 && s.distance <= b.possible) status = 'possible';
    else status = 'unlikely';

    const groups = faithGroups(s.religion);
    const isFaith = groups.size > 0;
    const sex = sexOf(s);
    const age = entryAge(s);
    const kind = age === 9 ? 'middle' : age === 13 ? 'upper' : g === 'Secondary' ? 'secondary' : age === 7 ? 'junior' : 'primary or infant';
    const nth = r === 1 ? 'the nearest' : `the ${ordinal(r)} nearest`;
    let detail = `${fmt(s.distance)} away and ${nth} ${kind} school${sex ? ` for ${sex}` : ''}. An estimate only: enter the council's last distance offered for a real answer.`;
    const sexTag = sex ? `${sex} only` : null;
    const short = FAITH_SHORT[[...groups][0]] || s.religion;
    const LABEL = { likely: 'Likely', possible: 'Possible', unlikely: 'Unlikely' };

    // No faith school, or the family hasn't said: as before.
    if (!isFaith) {
      s.catchment = { status, estimate: status, label: [LABEL[status], sexTag].filter(Boolean).join(' · '), detail, official: false, rank: r };
      continue;
    }
    if (!faith) {
      detail = `${s.religion} school: it may give priority to families of that faith before distance. ` + detail;
      s.catchment = { status: 'faith', estimate: status, label: [LABEL[status], 'faith priority', sexTag].filter(Boolean).join(' · '), detail, official: false, rank: r, faithNote: `${short} priority may come before distance` };
      continue;
    }
    if (groups.has(faith)) {
      detail = `${s.religion} school, matching your faith: you'd usually be in a priority group, then places go by distance. ` + detail;
      s.catchment = { status, estimate: status, label: [LABEL[status], 'your faith', sexTag].filter(Boolean).join(' · '), detail, official: false, rank: r, faithNote: 'matches your faith' };
      continue;
    }
    if ([...groups].every((x) => STRICT.has(x))) {
      // Distance doesn't decide this: it depends on whether places are left after families of the faith.
      const est = 'unlikely';
      detail = `${s.religion} school: places usually go to practising ${short} families first. It may take other local children if it isn't full, but living close doesn't guarantee that. ` + detail;
      s.catchment = { status: 'faith', estimate: est, label: [LABEL[est], 'may take others if not full', sexTag].filter(Boolean).join(' · '), detail, official: false, rank: r, faithNote: `${short} families usually come first` };
      continue;
    }
    // Church of England / other Christian: often plenty of open places.
    detail = `${s.religion} school: some places may be reserved for churchgoing families, but many such schools admit most children by distance. Check its admissions policy. ` + detail;
    s.catchment = { status, estimate: status, label: [LABEL[status], 'may have faith places', sexTag].filter(Boolean).join(' · '), detail, official: false, rank: r, faithNote: 'some places may be for churchgoers' };
  }
  return schools;
}

function fmt(m) {
  return m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(2)} miles`;
}
function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
