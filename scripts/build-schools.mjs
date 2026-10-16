// One-off setup: downloads Ofsted's latest inspection results for every state-funded
// school in England, finds each school's location from its postcode, and saves
// data/schools.json for the app to search.
//
// Run with:  npm run setup      (takes a minute or two; re-run monthly for fresh ratings)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, fetchJson, mapLimit, parseCsv, normalisePostcode } from '../lib/util.mjs';
import { headerIndex, schoolFromRow, earlierGradesFromCsv, withEarlierGrade } from '../lib/ofsted.mjs';

const GOVUK_PAGE = 'https://www.gov.uk/api/content/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes';

async function findLatestCsv() {
  const page = await fetchJson(GOVUK_PAGE);
  const attachments = (page.details?.attachments || []).filter(
    (a) => /latest inspections/i.test(a.title || '') && /\.csv$/i.test(a.url || ''),
  );
  if (!attachments.length) throw new Error('Could not find the "latest inspections" CSV on GOV.UK.');
  // Attachments are listed oldest first; take the last one.
  return attachments[attachments.length - 1];
}

// Official statistics snapshot with every school's last full grade, including those from before
// September 2019, which the monthly file leaves out. It's the last one before report cards.
const SNAPSHOT_PAGE = 'https://www.gov.uk/api/content/government/statistics/state-funded-schools-inspections-and-outcomes-as-at-31-august-2025';

async function downloadCsvText(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Doorstep/0.1' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  // Ofsted files are usually UTF-8, occasionally Windows-1252.
  const buf = Buffer.from(await res.arrayBuffer());
  let text = new TextDecoder('utf-8').decode(buf);
  if (text.includes('\uFFFD')) text = new TextDecoder('windows-1252').decode(buf);
  return text.replace(/^\uFEFF/, '');
}

async function earlierGrades() {
  const page = await fetchJson(SNAPSHOT_PAGE);
  const att = (page.details?.attachments || []).find(
    (a) => /^State-funded schools inspections and outcomes as at 31 August 2025$/i.test((a.title || '').trim()) && /\.csv$/i.test(a.url || ''),
  );
  if (!att) throw new Error('Could not find the 31 August 2025 snapshot CSV on GOV.UK.');
  return earlierGradesFromCsv(parseCsv(await downloadCsvText(att.url)));
}

async function geocode(postcodes) {
  const result = new Map();
  const chunks = [];
  for (let i = 0; i < postcodes.length; i += 100) chunks.push(postcodes.slice(i, i + 100));
  let done = 0;
  await mapLimit(chunks, 4, async (chunk) => {
    const res = await fetchJson('https://api.postcodes.io/postcodes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ postcodes: chunk }),
    });
    for (const r of res.result || []) {
      if (r.result) result.set(normalisePostcode(r.query), { lat: r.result.latitude, lng: r.result.longitude });
    }
    done += chunk.length;
    process.stdout.write(`\r  Located ${done.toLocaleString()} of ${postcodes.length.toLocaleString()} postcodes`);
  });
  process.stdout.write('\n');

  // Schools sometimes still use a postcode that has since been retired.
  const missing = postcodes.filter((p) => !result.has(p));
  if (missing.length) {
    console.log(`  Looking up ${missing.length} retired postcodes…`);
    await mapLimit(missing, 4, async (pc) => {
      const r = await fetchJson(`https://api.postcodes.io/terminated_postcodes/${encodeURIComponent(pc)}`, { allow404: true }).catch(() => null);
      if (r?.result?.latitude) result.set(pc, { lat: r.result.latitude, lng: r.result.longitude });
    });
  }
  return result;
}

async function main() {
  console.log('Finding the latest Ofsted inspection data on GOV.UK…');
  const att = await findLatestCsv();
  console.log(`  ${att.title}`);

  console.log('Downloading…');
  const text = await downloadCsvText(att.url);

  const rows = parseCsv(text);
  const idx = headerIndex(rows[0]);
  if (idx('URN') < 0 || idx('Postcode') < 0) throw new Error('The CSV columns have changed; URN or Postcode is missing.');
  const schools = rows.slice(1).map((r) => schoolFromRow(r, idx)).filter(Boolean);
  console.log(`  ${schools.length.toLocaleString()} schools`);

  console.log('Adding full grades from before September 2019 (Ofsted statistics, 31 August 2025)…');
  try {
    const earlier = await earlierGrades();
    let filled = 0;
    for (const s of schools) {
      const r = withEarlierGrade(s.rating, earlier.get(s.urn));
      if (r !== s.rating) { s.rating = r; filled++; }
    }
    console.log(`  ${filled.toLocaleString()} schools now show their earlier grade`);
  } catch (e) {
    // Not fatal: those schools just keep the "check the reports" note.
    console.log(`  Skipped (${e.message})`);
  }

  console.log('Finding school locations from postcodes (postcodes.io)…');
  const pcs = [...new Set(schools.map((s) => normalisePostcode(s.postcode)).filter(Boolean))];
  const coords = await geocode(pcs);

  let located = 0;
  for (const s of schools) {
    const c = coords.get(normalisePostcode(s.postcode));
    if (c) { s.lat = c.lat; s.lng = c.lng; located++; }
  }

  fs.mkdirSync(DATA_DIR, { recursive: true });
  const out = {
    source: att.title,
    sourceUrl: att.url,
    builtAt: new Date().toISOString(),
    schools: schools.filter((s) => s.lat),
  };
  fs.writeFileSync(path.join(DATA_DIR, 'schools.json'), JSON.stringify(out));
  console.log(`Saved ${located.toLocaleString()} schools with locations to data/schools.json`);
  if (located < schools.length) console.log(`  (${schools.length - located} schools had no usable postcode and were skipped)`);
}

main().catch((e) => {
  console.error('\nSetup failed:', e.message);
  process.exit(1);
});
