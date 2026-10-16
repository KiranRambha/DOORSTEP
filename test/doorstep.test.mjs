// Offline tests: every external API is replaced with a canned response shaped like the real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseCsv, normalisePostcode, median } from '../lib/util.mjs';
import { headerIndex, schoolFromRow } from '../lib/ofsted.mjs';
import { matchCertificate } from '../lib/epc.mjs';

const OFSTED_HEADER = 'Web Link,URN,LAESTAB,School name,Ofsted phase,Type of education,School open date,Admissions policy,Sixth form,Designated religious character,Religious ethos,Faith grouping,Ofsted region,Region,Local authority,Parliamentary constituency,Postcode,Multi-academy trust UID,Multi-academy trust name,Academy sponsor UID,Academy sponsor name,The income deprivation affecting children index (IDACI) quintile,Total number of pupils,Statutory lowest age,Statutory highest age,Inspection number of latest full inspection,Inspection type,Inspection type grouping,Event type grouping,Inspection start date,Publication date,Does the latest full inspection relate to the URN of the current school?,URN at time of latest full inspection,LAESTAB at time of latest full inspection,School name at time of latest full inspection,School type at time of latest full inspection,Category of concern,Safeguarding standards,Inclusion,Curriculum and teaching,Achievement,Attendance and behaviour,Personal development and wellbeing,Early years (where applicable),Post-16 provision (where applicable),Leadership and governance,Inspection number of latest OEIF graded inspection,Inspection type of latest OEIF graded inspection,Inspection type grouping of latest OEIF graded inspection,Event type grouping of latest OEIF graded inspection,Inspection start date of latest OEIF graded inspection,Publication date of latest OEIF graded inspection,Does the latest OEIF graded inspection relate to the URN of the current school?,URN at time of latest OEIF graded inspection,LAESTAB at time of latest OEIF graded inspection,School name at time of latest OEIF graded inspection,School type at time of latest OEIF graded inspection,Latest OEIF category of concern,Latest OEIF overall effectiveness,Latest OEIF quality of education,Latest OEIF behaviour and attitudes,Latest OEIF personal development,Latest OEIF effectiveness of leadership and management,Latest OEIF  safeguarding is effective?,Latest OEIF early years provision (where applicable),Latest OEIF sixth form provision (where applicable),Latest ungraded inspection number,Date of latest ungraded inspection,Ungraded inspection publication date,Does the ungraded inspection relate to the URN of the current school?,URN at time of the ungraded inspection,LAESTAB at time of the ungraded inspection,School name at time of the ungraded inspection,School type at time of the ungraded inspection,Ungraded inspection overall outcome,Most recent category of concern'.split(',');

function makeRow(values) {
  return OFSTED_HEADER.map((h) => (h in values ? values[h] : 'NULL'));
}

test('CSV parser handles quotes, commas and CRLF', () => {
  const rows = parseCsv('a,b,c\r\n"x, y","say ""hi""",3\r\n');
  assert.deepEqual(rows, [['a', 'b', 'c'], ['x, y', 'say "hi"', '3']]);
});

test('postcodes normalise', () => {
  assert.equal(normalisePostcode('sg51nz'), 'SG5 1NZ');
  assert.equal(normalisePostcode('SW1A 1AA'), 'SW1A 1AA');
  assert.equal(normalisePostcode('Hitchin'), null);
  assert.equal(median([3, 1, 2, 10]), 3);
  assert.equal(median([5, 1, 9]), 5);
});

test('Ofsted: report card school', () => {
  const idx = headerIndex(OFSTED_HEADER);
  const s = schoolFromRow(makeRow({
    'Web Link': 'http://www.ofsted.gov.uk/inspection-reports/find-inspection-report/provider/ELS/100001',
    URN: '100001', 'School name': 'Oak Primary', 'Ofsted phase': 'Primary', Postcode: 'SG5 1NZ',
    'Total number of pupils': '420', 'Statutory lowest age': '4', 'Statutory highest age': '11',
    'Inspection start date': '12/03/2026', 'Safeguarding standards': 'Met',
    Inclusion: 'Strong standard', 'Curriculum and teaching': 'Expected standard', Achievement: 'Expected standard',
    'Attendance and behaviour': 'Strong standard', 'Personal development and wellbeing': 'Strong standard',
    'Leadership and governance': 'Expected standard', 'Early years (where applicable)': 'Expected standard',
    'Latest OEIF overall effectiveness': '2', 'Inspection start date of latest OEIF graded inspection': '01/02/2019',
  }), idx);
  assert.equal(s.rating.system, 'Report card');
  assert.equal(s.rating.date, '2026-03-12');
  assert.equal(s.rating.tone, 'good');
  assert.match(s.rating.headline, /3 × Strong standard, 4 × Expected standard/);
  assert.equal(s.ages, '4–11');
  assert.ok(s.link.startsWith('https://'));
});

test('Ofsted: older Outstanding with a later short inspection', () => {
  const idx = headerIndex(OFSTED_HEADER);
  const s = schoolFromRow(makeRow({
    URN: '100002', 'School name': 'Elm Secondary', 'Ofsted phase': 'Secondary', Postcode: 'SG4 0TJ',
    'Latest OEIF overall effectiveness': '1', 'Inspection start date of latest OEIF graded inspection': '10/10/2014',
    'Latest OEIF quality of education': '1', 'Date of latest ungraded inspection': '05/05/2023',
    'Ungraded inspection overall outcome': 'School remains Outstanding',
  }), idx);
  assert.equal(s.rating.headline, 'Outstanding');
  assert.equal(s.rating.tone, 'great');
  assert.match(s.rating.note, /School remains Outstanding/);
});

test('Ofsted: 2024-25 inspection with no overall grade', () => {
  const idx = headerIndex(OFSTED_HEADER);
  const s = schoolFromRow(makeRow({
    URN: '100003', 'School name': 'Ash Academy', 'Ofsted phase': 'Secondary', Postcode: 'SG4 0TJ',
    'Latest OEIF overall effectiveness': 'Not judged', 'Inspection start date of latest OEIF graded inspection': '20/01/2025',
    'Latest OEIF quality of education': '3', 'Latest OEIF behaviour and attitudes': '2',
    'Latest OEIF personal development': '2', 'Latest OEIF effectiveness of leadership and management': '3',
  }), idx);
  assert.equal(s.rating.headline, 'Requires improvement for quality of education');
  assert.equal(s.rating.tone, 'mixed');
});

test('Ofsted: never inspected', () => {
  const idx = headerIndex(OFSTED_HEADER);
  const s = schoolFromRow(makeRow({ URN: '100004', 'School name': 'New Free School', Postcode: 'SG4 0TJ' }), idx);
  assert.equal(s.rating.headline, 'Not yet inspected');
  assert.equal(s.rating.score, null);
});

test('EPC matching picks the right house and latest certificate', () => {
  const certs = [
    { cert: 'A', address: '12 BEARTON AVENUE', date: '2015-01-01' },
    { cert: 'B', address: '2A BEARTON AVENUE', date: '2012-01-01' },
    { cert: 'C', address: '2A BEARTON AVENUE', date: '2021-06-01' },
    { cert: 'D', address: '2 BEARTON AVENUE', date: '2022-06-01' },
  ];
  assert.equal(matchCertificate({ paon: '2A', street: 'BEARTON AVENUE' }, certs).cert, 'C');
  assert.equal(matchCertificate({ paon: '2', street: 'BEARTON AVENUE' }, certs).cert, 'D');
  assert.equal(matchCertificate({ paon: '7', street: 'BEARTON AVENUE' }, certs), null);
  assert.equal(matchCertificate({ paon: 'ROSE COTTAGE', street: 'HIGH STREET' }, [{ cert: 'R', address: 'ROSE COTTAGE HIGH STREET', date: '2020-01-01' }]).cert, 'R');
});

/* ───────── End-to-end with a fake network ───────── */

test('API flows with mocked services', async () => {
  // Isolate the cache and schools file in a temp copy of the project.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'doorstep-'));
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
  fs.cpSync(path.join(root, 'lib'), path.join(tmp, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(tmp, 'data'));
  fs.writeFileSync(path.join(tmp, 'data', 'schools.json'), JSON.stringify({
    source: 'test', builtAt: 'now',
    schools: [
      { urn: '1', name: 'Near', phase: 'Primary', lat: 51.9536, lng: -0.2831, rating: { tone: 'good', score: 70 } },
      { urn: '2', name: 'Far', phase: 'Primary', lat: 52.2, lng: -0.28, rating: { tone: 'good', score: 70 } },
    ],
  }));

  const calls = [];
  globalThis.fetch = async (url, opts = {}) => {
    const u = String(url);
    calls.push(u);
    const json = (body, status = 200) => ({ ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) });
    if (u.includes('api.postcodes.io/postcodes/SG51NZ') || u.includes('api.postcodes.io/postcodes/SG5%201NZ')) {
      return json({ status: 200, result: { postcode: 'SG5 1NZ', latitude: 51.9535, longitude: -0.283, admin_ward: 'Hitchin Bearton', admin_district: 'North Hertfordshire', country: 'England' } });
    }
    if (u.includes('api.postcodes.io/places')) {
      return json({ result: [
        { name_1: 'Hitchin Square', local_type: 'Other Settlement', county_unitary: 'Greater London', latitude: 51.53, longitude: -0.03, country: 'England' },
        { name_1: 'Hitchin', local_type: 'Town', district_borough: 'North Hertfordshire', latitude: 51.9495, longitude: -0.28, country: 'England' },
      ] });
    }
    if (u.includes('api.postcodes.io/postcodes?lat=')) {
      return json({ result: [
        { postcode: 'SG5 1NZ', latitude: 51.9535, longitude: -0.283 },
        { postcode: 'SG5 1PA', latitude: 51.9545, longitude: -0.284 },
        { postcode: 'SG5 9ZZ', latitude: 51.99, longitude: -0.30 },
      ] });
    }
    if (u.includes('landregistry.data.gov.uk')) {
      assert.match(decodeURIComponent(opts.body), /VALUES \?pc \{ "SG5 1NZ" "SG5 1PA" \}/);
      const b = (amount, date, type, paon, pc, cat = 'standardPricePaidTransaction') => ({
        tx: { value: `tx-${paon}-${date}` }, amount: { value: String(amount) }, date: { value: date },
        type: { value: `http://landregistry.data.gov.uk/def/common/${type}` }, paon: { value: paon },
        street: { value: 'BEARTON AVENUE' }, town: { value: 'HITCHIN' }, pc: { value: pc },
        category: { value: `http://landregistry.data.gov.uk/def/ppi/${cat}` },
      });
      return json({ results: { bindings: [
        b(800000, '2026-08-20', 'detached', '2A', 'SG5 1NZ'),
        b(600000, '2025-03-01', 'semi-detached', '4', 'SG5 1NZ'),
        b(650000, '2026-01-10', 'semi-detached', '6', 'SG5 1PA'),
        b(200000, '2025-05-01', 'semi-detached', '8', 'SG5 1PA', 'additionalPricePaidTransaction'),
      ] } });
    }
    if (u.includes('data.police.uk/api/crimes-street-dates')) {
      return json([{ date: '2026-08' }, { date: '2026-07' }, { date: '2026-06' }]);
    }
    if (u.includes('data.police.uk/api/crimes-street')) {
      return json([
        { category: 'anti-social-behaviour', location: { latitude: '51.9495', longitude: '-0.2775', street: { name: 'On or near Hermitage Road' } } },
        { category: 'violent-crime', location: { street: { name: 'On or near Hermitage Road' } } },
        { category: 'burglary', location: { street: { name: 'On or near Bearton Avenue' } } },
      ]);
    }
    if (u.includes('api.tfl.gov.uk/StopPoint')) {
      return json({ stopPoints: [
        { naptanId: '910GHITCHIN', commonName: 'Hitchin Rail Station', lat: 51.9533, lon: -0.2635, modes: ['national-rail'], lines: [{ name: 'Thameslink' }] },
      ] });
    }
    if (u.includes('api.tfl.gov.uk/Journey')) {
      return json({ journeys: [
        { duration: 64, startDateTime: '2026-10-20T07:56:00', arrivalDateTime: '2026-10-20T09:00:00', legs: [
          { mode: { name: 'walking' }, duration: 5, instruction: { summary: 'Walk' } },
          { mode: { name: 'national-rail' }, duration: 40, instruction: { summary: 'Thameslink to Farringdon' }, routeOptions: [{ name: 'Thameslink' }] },
          { mode: { name: 'tube' }, duration: 10, instruction: { summary: 'Central line' }, routeOptions: [{ name: 'Central' }] },
        ] },
        { duration: 80, legs: [] },
      ] });
    }
    throw new Error('Unexpected URL in test: ' + u);
  };

  const src = await import(path.join(tmp, 'lib', 'sources.mjs'));

  const pc = await src.lookupLocation('sg5 1nz');
  assert.equal(pc.label, 'SG5 1NZ');
  const town = await src.lookupLocation('Hitchin');
  assert.equal(town.label, 'Hitchin');

  const schools = src.nearbySchools(51.9535, -0.283, 3000);
  assert.equal(schools.ready, true);
  assert.deepEqual(schools.schools.map((s) => s.name), ['Near']);

  const t = await src.transport(51.9535, -0.283, 'bank');
  assert.equal(t.doorToDoor.minutes, 64);
  assert.equal(t.doorToDoor.changes, 1);
  assert.equal(t.stations[0].name, 'Hitchin');
  assert.equal(t.stations[0].toLondon.minutes, 64);

  const c = await src.crime(51.9535, -0.283, 12);
  assert.equal(c.monthsCounted, 3);
  assert.equal(c.total, 9);
  assert.equal(c.hotspots[0].street, 'Hermitage Road');
  assert.equal(c.months[0].month, '2026-06');
  assert.equal(c.points.length, 3, 'only reports with a location become map points');
  assert.deepEqual(c.points[0].slice(2, 4), ['anti-social-behaviour', 'Hermitage Road']);
  assert.equal(c.previous, null, 'no year-on-year figure without 12 earlier months');
  assert.equal(c.labels.burglary, 'Burglary');

  const p = await src.prices(51.9535, -0.283, { radiusM: 1000, years: 3 });
  assert.equal(p.sales.length, 3, 'non-market sale excluded');
  assert.equal(p.excluded, 1);
  assert.equal(p.summary['Semi-detached'].median, 625000);
  assert.equal(p.summary.Detached.median, 800000);
  assert.equal(p.epc.enabled, false);

  // Second call should come from cache (no new network calls).
  const before = calls.length;
  await src.prices(51.9535, -0.283, { radiusM: 1000, years: 3 });
  assert.equal(calls.length, before);
});

test('Short inspections get a colour', async () => {
  const { refineRating } = await import('../lib/ofsted.mjs');
  const r = (h) => refineRating({ system: 'Ungraded inspection', headline: h, tone: 'none', score: null, areas: [] });
  assert.equal(r('School remains Good').tone, 'good');
  assert.equal(r('School remains Outstanding (Concerns) - S5 Next').tone, 'great');
  assert.equal(r('School remains Outstanding (Concerns) - S5 Next').headline, 'School remains Outstanding (Concerns)');
  assert.equal(r('Some aspects not as strong').tone, 'mixed');
  assert.equal(r('Standards maintained').tone, 'none');
  assert.equal(refineRating({ system: 'Report card', tone: 'good' }).tone, 'good');
});

test('Catchment estimate and saved cut-offs', async () => {
  const { addCatchment } = await import('../lib/catchment.mjs');
  const schools = [
    { urn: '1', phase: 'Primary', distance: 650, religion: 'Does not apply' },
    { urn: '2', phase: 'Primary', distance: 900, religion: 'Church of England' },
    { urn: '3', phase: 'Primary', distance: 1300, religion: 'None' },
    { urn: '4', phase: 'Primary', distance: 2500, religion: 'None' },
    { urn: '5', phase: 'Secondary', distance: 2600, admissions: 'Non-selective' },
    { urn: '6', phase: 'Secondary', distance: 3000, admissions: 'Selective' },
    { urn: '7', phase: 'Special', distance: 500 },
    { urn: '8', phase: 'Primary', distance: 300, religion: 'None' },
  ];
  addCatchment(schools, { 3: { metres: 1609, note: '2026 entry' }, 4: { metres: 1200 } });
  const by = Object.fromEntries(schools.map((s) => [s.urn, s.catchment]));
  assert.equal(by[8].status, 'likely');            // within 400 m
  assert.equal(by[1].status, 'possible');          // 2nd nearest, under 1.5 km
  assert.equal(by[2].status, 'faith');
  assert.equal(by[2].estimate, 'possible');
  assert.equal(by[3].status, 'in');                // saved cut-off beats estimate
  assert.equal(by[3].note, '2026 entry');
  assert.equal(by[4].status, 'out');
  assert.equal(by[5].status, 'likely');            // nearest secondary within 3 km
  assert.equal(by[6].status, 'selective');
  assert.equal(by[7].status, 'special');
});

test('Faith setting changes catchment estimates', async () => {
  const { addCatchment, faithGroups } = await import('../lib/catchment.mjs');
  assert.deepEqual([...faithGroups('Roman Catholic/Church of England')].sort(), ['catholic', 'coe']);
  assert.equal(faithGroups('Does not apply').size, 0);
  const make = () => [
    { urn: 'rc', phase: 'Primary', distance: 300, religion: 'Roman Catholic' },
    { urn: 'ce', phase: 'Primary', distance: 500, religion: 'Church of England' },
    { urn: 'cm', phase: 'Primary', distance: 700, religion: 'Does not apply' },
    { urn: 'rc2', phase: 'Primary', distance: 900, religion: 'Catholic' },
  ];
  const by = (list) => Object.fromEntries(list.map((s) => [s.urn, s.catchment]));

  // Not set: faith schools flagged, as before.
  let c = by(addCatchment(make(), {}, {}));
  assert.equal(c.rc.status, 'faith');
  assert.equal(c.cm.rank, 3);

  // No faith: Catholic schools out of reach and don't count when ranking others.
  c = by(addCatchment(make(), {}, { faith: 'none' }));
  assert.equal(c.rc.estimate, 'unlikely');          // same answer however close
  assert.match(c.rc.label, /may take others if not full/);
  assert.equal(c.rc2.estimate, 'unlikely');
  assert.equal(c.ce.status, 'likely');              // CofE: distance-based, softer note
  assert.match(c.ce.label, /may have faith places/);
  assert.equal(c.cm.rank, 2);                       // the Catholic school no longer counts
  assert.equal(c.cm.status, 'possible');

  // Catholic family: Catholic schools treated on distance.
  c = by(addCatchment(make(), {}, { faith: 'catholic' }));
  assert.equal(c.rc.status, 'likely');
  assert.match(c.rc.label, /your faith/);
  assert.equal(c.cm.rank, 3);
});
