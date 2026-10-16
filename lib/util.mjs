import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA_DIR = path.join(ROOT, 'data');
const CACHE_DIR = path.join(DATA_DIR, 'cache');

const UA = 'Doorstep/0.1 (personal home-search tool)';

/** Load KEY=value pairs from .env into process.env (without overriding real env vars). */
export function loadEnv() {
  const file = path.join(ROOT, '.env');
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (!m || line.trim().startsWith('#')) continue;
    let v = m[2];
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    if (process.env[m[1]] === undefined) process.env[m[1]] = v;
  }
}

/** fetch with a timeout, retries on 429/5xx, and a clear error message. */
export async function fetchJson(url, { method = 'GET', headers = {}, body, timeout = 30000, retries = 2, allow404 = false } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeout);
    try {
      const res = await fetch(url, {
        method,
        body,
        signal: ctrl.signal,
        headers: { 'User-Agent': UA, Accept: 'application/json', ...headers },
      });
      if (res.status === 404 && allow404) return null;
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`${new URL(url).host} returned ${res.status}`);
        lastErr.status = res.status;
        await sleep(800 * (attempt + 1));
        continue;
      }
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        const err = new Error(`${new URL(url).host} returned ${res.status}: ${text.slice(0, 200)}`);
        err.status = res.status;
        throw err;
      }
      return await res.json();
    } catch (e) {
      lastErr = e.name === 'AbortError' ? new Error(`${new URL(url).host} timed out`) : e;
      if (e.status && e.status < 500 && e.status !== 429) throw lastErr;
      if (attempt < retries) await sleep(500 * (attempt + 1));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run async fn over items with limited concurrency, preserving order. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

/** Small disk cache so repeat searches are instant and we stay polite to the free APIs. */
export async function cached(key, ttlHours, fn) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const file = path.join(CACHE_DIR, crypto.createHash('sha1').update(key).digest('hex') + '.json');
  try {
    const stat = fs.statSync(file);
    if (ttlHours === Infinity || Date.now() - stat.mtimeMs < ttlHours * 3600e3) {
      return JSON.parse(fs.readFileSync(file, 'utf8'));
    }
  } catch { /* cache miss */ }
  const value = await fn();
  try { fs.writeFileSync(file, JSON.stringify(value)); } catch { /* ignore */ }
  return value;
}

/** Great-circle distance in metres. */
export function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Move a point by metres north/east. */
export function offset(lat, lng, northM, eastM) {
  return {
    lat: lat + northM / 111320,
    lng: lng + eastM / (111320 * Math.cos((lat * Math.PI) / 180)),
  };
}

export function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : Math.round((s[m - 1] + s[m]) / 2);
}

/** Minimal RFC 4180 CSV parser (handles quotes, commas and newlines inside quotes). */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += ch;
    } else if (ch === '"') inQuotes = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0] !== '') rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export function normalisePostcode(pc) {
  const s = String(pc || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{1,2}\d[A-Z\d]?\d[A-Z]{2}$/.test(s)) return null;
  return `${s.slice(0, -3)} ${s.slice(-3)}`;
}

/** Only let this app change saved data. Other websites can POST to localhost without asking
 *  unless the body is JSON (which forces a browser preflight we never answer), and the
 *  browser always tells us their Origin. */
export function isSafeWrite(headers, { body = true } = {}) {
  const origin = headers.origin;
  if (origin) {
    let host;
    try { host = new URL(origin).host; } catch { return false; }
    if (host !== headers.host) return false;
  }
  if (body && !/^application\/json\b/i.test(headers['content-type'] || '')) return false;
  return true;
}
