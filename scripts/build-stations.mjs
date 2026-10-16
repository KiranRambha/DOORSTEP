// One-off setup for Find places: lists rail stations outside London and plans each one's fastest
// weekday trip into a central terminus, then saves data/stations.json.
//
// Run with:  npm run setup:stations   (takes 20 to 40 minutes; re-run every few months.
// If it stops part-way, run it again: finished journeys are cached and skipped.)

import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, loadEnv } from '../lib/util.mjs';
import { buildStations } from '../lib/stations.mjs';

async function main() {
  loadEnv();
  if (!process.env.TFL_APP_KEY) console.log('Tip: add TFL_APP_KEY to .env, or TfL may rate-limit this run.');
  const out = await buildStations();
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const file = path.join(DATA_DIR, 'stations.json');
  // Write then rename, so a failed run never leaves a half-written file.
  fs.writeFileSync(file + '.tmp', JSON.stringify(out));
  fs.renameSync(file + '.tmp', file);
  console.log(`Saved ${out.stations.length} stations (${out.failed} couldn't be planned) to data/stations.json`);
}

main().catch((e) => {
  console.error('\nStation setup failed:', e.message);
  process.exit(1);
});
