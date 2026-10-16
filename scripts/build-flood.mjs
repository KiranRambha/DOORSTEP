// One-off setup: downloads the Environment Agency's list of postcodes with homes at
// risk of flooding from rivers and the sea, and saves data/flood.json.
//
// Run with:  npm run setup:flood   (also runs as part of npm run setup; the EA updates it quarterly)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../lib/util.mjs';
import { readZipEntry } from '../lib/unzip.mjs';
import { parseFloodCsv } from '../lib/flood.mjs';

const TITLE = 'Risk of Flooding from Rivers and Sea – Postcodes in Areas at Risk (Environment Agency)';
const URL = 'https://environment.data.gov.uk/api/file/download?fileDataSetId=97781741-2982-4802-af2e-313fe3fd8f7e&fileName=RoFRS_Postcodes_in_Areas_at_Risk.zip';

async function main() {
  console.log('Downloading Environment Agency flood postcodes…');
  const res = await fetch(URL, { headers: { 'User-Agent': 'Doorstep/0.1' } });
  if (!res.ok) throw new Error(`Download failed: ${res.status}`);
  const entry = readZipEntry(Buffer.from(await res.arrayBuffer()), /AtRisk\.csv$/i);
  if (!entry) throw new Error('The download no longer contains the postcode CSV.');

  const postcodes = parseFloodCsv(entry.data.toString('utf8'));
  const out = { source: TITLE, sourceUrl: URL, fileDate: entry.modified, builtAt: new Date().toISOString(), postcodes };
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'flood.json');
  // Write then rename, so a failed run never leaves a half-written file.
  fs.writeFileSync(file + '.tmp', JSON.stringify(out));
  fs.renameSync(file + '.tmp', file);
  console.log(`Saved ${Object.keys(postcodes).length.toLocaleString()} postcodes (file dated ${entry.modified}) to data/flood.json`);
}

main().catch((e) => {
  console.error('\nFlood setup failed:', e.message);
  process.exit(1);
});
