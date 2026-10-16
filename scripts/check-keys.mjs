// Checks the optional API keys in .env actually work, without printing them.
// Run with:  npm run check

import { loadEnv } from '../lib/util.mjs';

loadEnv();
const POSTCODE = process.argv[2] || 'SG5 1NZ';
const ok = (msg) => console.log(`  ✓ ${msg}`);
const bad = (msg) => console.log(`  ✗ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);

async function get(url, headers = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 30000);
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json', 'User-Agent': 'Doorstep/0.1', ...headers }, signal: ctrl.signal });
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* not JSON */ }
    return { status: res.status, json, text };
  } finally {
    clearTimeout(t);
  }
}

async function checkEpc() {
  console.log('\nEPC (bedroom / floor-area filter)');
  const token = process.env.EPC_TOKEN;
  if (!token) return bad('EPC_TOKEN is not set in .env');
  const base = 'https://api.get-energy-performance-data.communities.gov.uk';
  const auth = { Authorization: `Bearer ${token}` };

  const search = await get(`${base}/api/domestic/search?postcode=${encodeURIComponent(POSTCODE).replace(/%20/g, '+')}&page_size=50`, auth);
  if (search.status === 401 || search.status === 403) return bad(`Token rejected (HTTP ${search.status}). Sign in again to get a fresh token.`);
  if (search.status === 404) return ok(`Token accepted, but no certificates were found for ${POSTCODE}. Try another postcode: npm run check -- "SW1A 1AA"`);
  if (search.status !== 200) return bad(`Search failed: HTTP ${search.status} ${search.text.slice(0, 160)}`);

  const list = Array.isArray(search.json?.data) ? search.json.data : Array.isArray(search.json?.data?.data) ? search.json.data.data : null;
  if (!list) return bad(`Token accepted, but the reply isn't in the expected shape. Top-level keys: ${Object.keys(search.json || {}).join(', ')}`);
  ok(`Token accepted: ${list.length} certificate(s) found for ${POSTCODE}`);
  if (!list.length) return;
  const first = list[0];
  const certNo = first.certificateNumber || first.certificate_number;
  info(`Search fields the app relies on: certificateNumber ${certNo ? 'yes' : 'MISSING'}, addressLine1 ${'addressLine1' in first || 'address_line_1' in first ? 'yes' : 'MISSING'}`);
  if (!certNo) return bad(`Can't find a certificate number. Fields present: ${Object.keys(first).join(', ')}`);

  const cert = await get(`${base}/api/certificate?certificate_number=${encodeURIComponent(certNo)}`, auth);
  if (cert.status !== 200) return bad(`Certificate lookup failed: HTTP ${cert.status} ${cert.text.slice(0, 160)}`);
  const d = cert.json?.data || {};
  const rooms = d.habitable_room_count ?? d.number_habitable_rooms ?? d.habitableRoomCount;
  const area = d.total_floor_area ?? d.totalFloorArea;
  if (rooms !== undefined || area !== undefined) {
    ok(`Certificate details work: habitable rooms ${rooms !== undefined ? 'found' : 'missing'}, floor area ${area !== undefined ? 'found' : 'missing'}`);
    if (rooms === undefined) info('(Newer new-build certificates sometimes omit room counts; the app then uses floor area only.)');
  } else {
    bad('Certificate fetched, but neither room count nor floor area was found.');
    info(`Fields present: ${Object.keys(d).slice(0, 40).join(', ')}`);
  }
}

async function checkTfl() {
  console.log('\nTfL (stations and commute)');
  const key = process.env.TFL_APP_KEY;
  const q = key ? `&app_key=${encodeURIComponent(key)}` : '';
  const r = await get(`https://api.tfl.gov.uk/StopPoint?lat=51.9535&lon=-0.283&stopTypes=NaptanRailStation&radius=3000${q}`);
  if (r.status === 200) ok(key ? 'App key accepted' : 'Working without a key (fine for light use)');
  else if (r.status === 401 || r.status === 403) bad(`App key rejected (HTTP ${r.status}). Check it on api-portal.tfl.gov.uk`);
  else if (r.status === 429) bad('Rate-limited (HTTP 429). Adding or fixing TFL_APP_KEY raises the limit.');
  else bad(`Unexpected reply: HTTP ${r.status}`);
}

console.log('Checking API keys from .env (keys are never printed)…');
await checkEpc().catch((e) => bad(`EPC check failed: ${e.message}`));
await checkTfl().catch((e) => bad(`TfL check failed: ${e.message}`));
console.log('');
