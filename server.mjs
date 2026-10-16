import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, loadEnv, isSafeWrite } from './lib/util.mjs';
import { lookupLocation, nearbySchools, transport, crime, prices, DESTINATIONS } from './lib/sources.mjs';
import { saveOverride } from './lib/catchment.mjs';
import { flood } from './lib/flood.mjs';
import { loadShortlist, saveEntry, removeEntry } from './lib/shortlist.mjs';
import { findStations, stationPrice } from './lib/stations.mjs';

loadEnv();
const PORT = Number(process.env.PORT) || 5173;
const PUBLIC = path.join(ROOT, 'public');
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function point(params) {
  const lat = Number(params.get('lat'));
  const lng = Number(params.get('lng'));
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < 49 || lat > 56 || lng < -7 || lng > 2.5) {
    throw Object.assign(new Error('lat and lng must be a point in England or Wales.'), { status: 400 });
  }
  return { lat, lng };
}

const routes = {
  '/api/lookup': async (p) => lookupLocation(p.get('q')),
  '/api/schools': async (p) => {
    const { lat, lng } = point(p);
    return nearbySchools(lat, lng, Math.min(Number(p.get('radius')) || 3000, 8000), p.get('faith') || null);
  },
  '/api/transport': async (p) => {
    const { lat, lng } = point(p);
    return transport(lat, lng, p.get('dest') || 'bank');
  },
  '/api/crime': async (p) => {
    const { lat, lng } = point(p);
    return crime(lat, lng, Math.min(Number(p.get('months')) || 12, 24));
  },
  '/api/prices': async (p) => {
    const { lat, lng } = point(p);
    return prices(lat, lng, {
      radiusM: Math.min(Number(p.get('radius')) || 1000, 1500),
      years: Math.min(Number(p.get('years')) || 3, 10),
    });
  },
  '/api/flood': async (p) => {
    const { lat, lng } = point(p);
    return flood(lat, lng);
  },
  '/api/find': async (p) => findStations(p.get('faith') || null),
  '/api/find/price': async (p) => stationPrice(String(p.get('id') || ''), Number(p.get('budget')) || 0),
  '/api/config': async () => ({
    destinations: Object.entries(DESTINATIONS).map(([key, d]) => ({ key, name: d.name })),
    epcEnabled: Boolean(process.env.EPC_TOKEN),
    schoolsReady: fs.existsSync(path.join(ROOT, 'data', 'schools.json')),
  }),
};

async function readBody(req, maxBytes = 10000) {
  let raw = '';
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > maxBytes) throw Object.assign(new Error('Request too large.'), { status: 413 });
  }
  try { return JSON.parse(raw || '{}'); } catch { throw Object.assign(new Error('Body must be JSON.'), { status: 400 }); }
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  // Save or clear a school's "last distance offered" (only accepted from this computer).
  if (url.pathname === '/api/catchment' && req.method === 'POST') {
    try {
      if (!isSafeWrite(req.headers)) throw Object.assign(new Error('Saves are only accepted from this app.'), { status: 403 });
      const { urn, metres, note } = await readBody(req);
      if (!/^\d{5,7}$/.test(String(urn))) throw Object.assign(new Error('Unknown school.'), { status: 400 });
      const m = metres === null || metres === '' ? null : Number(metres);
      if (m !== null && !(m > 0 && m < 50000)) throw Object.assign(new Error('Enter a distance between 1 metre and 50 km.'), { status: 400 });
      send(res, 200, { saved: saveOverride(String(urn), m, note) });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
    return;
  }

  // The saved shortlist (only reachable from this computer: the server binds to 127.0.0.1).
  if (url.pathname === '/api/shortlist') {
    try {
      if (req.method !== 'GET' && !isSafeWrite(req.headers, { body: req.method === 'POST' })) {
        throw Object.assign(new Error('Changes are only accepted from this app.'), { status: 403 });
      }
      if (req.method === 'GET') send(res, 200, { entries: loadShortlist() });
      else if (req.method === 'POST') send(res, 200, { saved: saveEntry(await readBody(req, 50000), { mustExist: url.searchParams.get('refresh') === '1' }) });
      else if (req.method === 'DELETE') send(res, 200, { removed: removeEntry(String(url.searchParams.get('id') || '')) });
      else send(res, 405, { error: 'Method not allowed.' });
    } catch (e) {
      send(res, e.status || 500, { error: e.message });
    }
    return;
  }

  const route = routes[url.pathname];
  if (route) {
    const started = Date.now();
    try {
      const data = await route(url.searchParams);
      send(res, 200, data);
      console.log(`${url.pathname}${url.search}  ${Date.now() - started}ms`);
    } catch (e) {
      console.error(`${url.pathname} failed:`, e.message);
      send(res, e.status && e.status < 500 ? e.status : 502, { error: e.message });
    }
    return;
  }

  // Static files
  const rel = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname).replace(/^\/+/, '');
  const file = path.join(PUBLIC, rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
    return;
  }
  // no-cache: the browser re-checks each load, so code updates show up straight away.
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`\n  Doorstep is running at http://localhost:${PORT}\n`);
  if (!fs.existsSync(path.join(ROOT, 'data', 'schools.json'))) {
    console.log('  School ratings aren\'t downloaded yet. Run "npm run setup" once, then restart.\n');
  }
  if (!process.env.EPC_TOKEN) {
    console.log('  Tip: add EPC_TOKEN to .env to estimate bedrooms for each sale (see README).\n');
  }
});
