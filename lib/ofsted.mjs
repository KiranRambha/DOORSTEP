// Turns one row of Ofsted's "latest inspections" management-information CSV into a
// compact school record. Ofsted has used three systems in recent years, so a school's
// latest result can be any of these:
//   1. Report card (from November 2025): a grade for each area, plus safeguarding met / not met.
//   2. Graded inspection under the older framework (OEIF): overall effectiveness 1-4.
//      Inspections from September 2024 to November 2025 gave no overall grade ("Not judged"),
//      only the sub-judgements.
//   3. Ungraded (short) inspection, which only says whether the previous grade still stands.

const OEIF_LABEL = { 1: 'Outstanding', 2: 'Good', 3: 'Requires improvement', 4: 'Inadequate' };

// Report-card scale, best first. Scores run 5 (best) to 1.
const RC_SCALE = {
  'Exceptional': 5,
  'Strong standard': 4,
  'Expected standard': 3,
  'Needs attention': 2,
  'Urgent improvement': 1,
};

const RC_AREAS = [
  ['Inclusion', 'Inclusion'],
  ['Curriculum and teaching', 'Curriculum and teaching'],
  ['Achievement', 'Achievement'],
  ['Attendance and behaviour', 'Attendance and behaviour'],
  ['Personal development and wellbeing', 'Personal development'],
  ['Leadership and governance', 'Leadership'],
  ['Early years (where applicable)', 'Early years'],
  ['Post-16 provision (where applicable)', 'Sixth form'],
];

const OEIF_AREAS = [
  ['Latest OEIF quality of education', 'Quality of education'],
  ['Latest OEIF behaviour and attitudes', 'Behaviour and attitudes'],
  ['Latest OEIF personal development', 'Personal development'],
  ['Latest OEIF effectiveness of leadership and management', 'Leadership'],
  ['Latest OEIF early years provision (where applicable)', 'Early years'],
  ['Latest OEIF sixth form provision (where applicable)', 'Sixth form'],
];

const clean = (v) => {
  const s = (v ?? '').trim();
  return s === '' || s.toUpperCase() === 'NULL' ? null : s;
};

/** dd/mm/yyyy -> yyyy-mm-dd */
export function isoDate(v) {
  const s = clean(v);
  if (!s) return null;
  const m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  const d = new Date(s);
  return isNaN(d) ? null : d.toISOString().slice(0, 10);
}

/** Build a column-name -> index lookup that tolerates odd spacing in Ofsted headers. */
export function headerIndex(header) {
  const norm = (s) => s.toLowerCase().replace(/\s+/g, ' ').trim();
  const map = new Map(header.map((h, i) => [norm(h), i]));
  return (name) => {
    const i = map.get(norm(name));
    return i === undefined ? -1 : i;
  };
}

/**
 * Summarise the rating for one school.
 * Returns { system, headline, tone, score, date, areas: [{label, grade}], safeguarding, note }
 *  - tone: 'great' | 'good' | 'mixed' | 'poor' | 'none'  (drives colour in the UI)
 *  - score: 0-100 for sorting (null if never inspected)
 */
export function summariseRating(get) {
  // 1. Report card
  const safeguarding = clean(get('Safeguarding standards'));
  if (safeguarding) {
    const areas = RC_AREAS
      .map(([col, label]) => ({ label, grade: clean(get(col)) }))
      .filter((a) => a.grade && RC_SCALE[a.grade]);
    const scores = areas.map((a) => RC_SCALE[a.grade]);
    const avg = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : 3;
    const min = scores.length ? Math.min(...scores) : 3;
    let tone = avg >= 4 ? 'great' : avg >= 3 && min >= 3 ? 'good' : min <= 1 ? 'poor' : 'mixed';
    if (safeguarding.toLowerCase().includes('not met')) tone = 'poor';
    const counts = {};
    for (const a of areas) counts[a.grade] = (counts[a.grade] || 0) + 1;
    const headline = Object.entries(counts)
      .sort((a, b) => RC_SCALE[b[0]] - RC_SCALE[a[0]])
      .map(([g, n]) => `${n} × ${g}`)
      .join(', ');
    return {
      system: 'Report card',
      headline: headline || 'Report card',
      tone,
      score: Math.round(((avg - 1) / 4) * 100),
      date: isoDate(get('Inspection start date')),
      areas,
      safeguarding,
      note: null,
    };
  }

  // 2. Older graded framework
  const overall = clean(get('Latest OEIF overall effectiveness'));
  const oeifDate = isoDate(get('Inspection start date of latest OEIF graded inspection'));
  const ungraded = clean(get('Ungraded inspection overall outcome'));
  const ungradedDate = isoDate(get('Date of latest ungraded inspection'));
  const note = ungraded && (!oeifDate || (ungradedDate && ungradedDate > oeifDate))
    ? `Short inspection ${ungradedDate ? ungradedDate.slice(0, 7) : ''}: ${ungraded}`.trim()
    : null;
  const areas = OEIF_AREAS
    .map(([col, label]) => {
      const g = clean(get(col));
      return { label, grade: g && OEIF_LABEL[g] ? OEIF_LABEL[g] : null };
    })
    .filter((a) => a.grade);

  if (overall && OEIF_LABEL[overall]) {
    const n = Number(overall);
    return {
      system: 'Graded inspection',
      headline: OEIF_LABEL[n],
      tone: n === 1 ? 'great' : n === 2 ? 'good' : n === 3 ? 'mixed' : 'poor',
      score: [null, 100, 70, 35, 0][n],
      date: oeifDate,
      areas,
      safeguarding: clean(get('Latest OEIF  safeguarding is effective?')) ?? clean(get('Latest OEIF safeguarding is effective?')),
      note,
    };
  }

  if (areas.length) {
    // Inspected Sept 2024 - Nov 2025: no overall grade, but sub-grades exist.
    const nums = OEIF_AREAS.map(([col]) => Number(clean(get(col)))).filter((n) => n >= 1 && n <= 4);
    const avg = nums.reduce((a, b) => a + b, 0) / nums.length;
    const q = areas.find((a) => a.label === 'Quality of education');
    return {
      system: 'Graded inspection (no overall grade)',
      headline: q ? `${q.grade} for quality of education` : areas[0].grade,
      tone: avg <= 1.5 ? 'great' : avg <= 2.2 ? 'good' : avg <= 3 ? 'mixed' : 'poor',
      score: Math.round(((4 - avg) / 3) * 100),
      date: oeifDate,
      areas,
      safeguarding: clean(get('Latest OEIF  safeguarding is effective?')) ?? clean(get('Latest OEIF safeguarding is effective?')),
      note,
    };
  }

  if (ungraded) {
    return refineRating({ system: 'Ungraded inspection', headline: ungraded, tone: 'none', score: null, date: ungradedDate, areas: [], safeguarding: null, note: null });
  }

  return { system: null, headline: 'Not yet inspected', tone: 'none', score: null, date: null, areas: [], safeguarding: null, note: null };
}

/**
 * Short (ungraded) inspections only say whether the previous grade still stands.
 * Turn the common outcomes into a colour so these schools aren't left grey.
 * Safe to run on ratings built by older versions of the setup script.
 */
export function refineRating(r) {
  if (!r || r.system !== 'Ungraded inspection') return r;
  const h = (r.headline || '').toLowerCase();
  const concerns = h.includes('concerns');
  let tone = 'none';
  let score = null;
  if (h.startsWith('school remains outstanding')) { tone = 'great'; score = concerns ? 85 : 95; }
  else if (h.startsWith('school remains good')) { tone = 'good'; score = concerns ? 60 : 70; }
  else if (h.startsWith('improved significantly')) { tone = 'good'; score = 65; }
  else if (h.startsWith('some aspects not as strong')) { tone = 'mixed'; score = 45; }
  const headline = r.headline.replace(/ - S5 Next$/, '');
  const note = concerns ? 'Inspectors flagged concerns, so a full inspection is due next.'
    : h.includes('(improving)') ? 'Inspectors saw signs it may be improving; a full inspection is due next.'
    : h.startsWith('standards maintained') ? 'A short inspection found the previous grade still stands. The earlier grade isn\'t in Ofsted\'s file, so check the reports.'
    : r.note;
  return { ...r, system: 'Short inspection', headline, tone, score, note };
}

/** Convert a CSV row (array) into a school record without coordinates. */
export function schoolFromRow(row, idx) {
  const get = (name) => {
    const i = idx(name);
    return i >= 0 ? row[i] : undefined;
  };
  const urn = clean(get('URN'));
  if (!urn) return null;
  const lowest = Number(clean(get('Statutory lowest age')));
  const highest = Number(clean(get('Statutory highest age')));
  return {
    urn,
    name: clean(get('School name')),
    phase: clean(get('Ofsted phase')),
    type: clean(get('Type of education')),
    postcode: clean(get('Postcode')),
    la: clean(get('Local authority')),
    pupils: Number(clean(get('Total number of pupils'))) || null,
    ages: lowest && highest ? `${lowest}–${highest}` : null,
    sixthForm: clean(get('Sixth form')),
    admissions: clean(get('Admissions policy')),
    religion: clean(get('Designated religious character')),
    link: (clean(get('Web Link')) || '').replace(/^http:/, 'https:') || null,
    rating: summariseRating(get),
  };
}

/**
 * Ofsted's monthly file only has full grades from September 2019. Its official statistics
 * snapshot "as at 31 August 2025" (the last before report cards) still has each school's
 * last full grade, back to 2009. Returns Map(urn -> { overall, date, previousName, safeguarding }).
 */
export function earlierGradesFromCsv(rows) {
  const idx = headerIndex(rows[0]);
  const col = (row, name) => { const i = idx(name); return i >= 0 ? row[i] : undefined; };
  const out = new Map();
  for (const row of rows.slice(1)) {
    const urn = clean(col(row, 'URN'));
    const overall = Number(clean(col(row, 'Overall effectiveness')));
    if (!urn || !OEIF_LABEL[overall]) continue;
    const sameSchool = (clean(col(row, 'Does the latest graded inspection relate to the URN of the current school?')) || 'Yes') === 'Yes';
    const sg = clean(col(row, 'Safeguarding is effective?'));
    out.set(urn, {
      overall,
      date: isoDate(col(row, 'Inspection start date')),
      predecessor: !sameSchool,
      // Only worth naming the old school if it had a different name.
      previousName: sameSchool ? null : clean(col(row, 'School name at time of latest graded inspection')),
      currentName: clean(col(row, 'School name')),
      safeguarding: sg === 'Yes' || sg === 'No' ? sg : null, // other codes (e.g. 9) mean not recorded
    });
  }
  return out;
}

/** Give a school with only a short inspection (or nothing) its earlier full grade. */
export function withEarlierGrade(r, earlier) {
  if (!earlier || !r || !['Short inspection', 'Ungraded inspection', null].includes(r.system)) return r;
  const n = earlier.overall;
  const short = r.system ? r.headline : null;
  const notes = [
    short && `Short inspection ${r.date ? r.date.slice(0, 7) : ''}: ${short}.`.replace(' :', ':'),
    short && /concerns/i.test(short) ? 'Inspectors flagged concerns, so a full inspection is due next.' : null,
    short && /\(improving\)/i.test(short) ? 'Inspectors saw signs it may be improving; a full inspection is due next.' : null,
    !earlier.predecessor ? null
      : earlier.previousName && earlier.previousName.toLowerCase() !== (earlier.currentName || '').toLowerCase()
        ? `This grade was given to ${earlier.previousName}, the school before it became this one.`
        : 'This grade is from before the school became an academy or changed its legal status.',
  ].filter(Boolean);
  return {
    system: 'Graded inspection',
    headline: OEIF_LABEL[n],
    tone: n === 1 ? 'great' : n === 2 ? 'good' : n === 3 ? 'mixed' : 'poor',
    score: [null, 100, 70, 35, 0][n],
    date: earlier.date,
    areas: [],
    safeguarding: earlier.safeguarding,
    note: notes.join(' ') || null,
  };
}
