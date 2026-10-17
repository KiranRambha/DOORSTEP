// Find places view: settings bar, ranked list of stations, prices filling in, and a map of matches.
// The rules live in find.js; this file only fetches and draws.
import { priceVerdict, rankStations, retryable, MAX_WALK } from './find.js';
import { friendlyError } from './errors.js';

const $ = (s, el = document) => el.querySelector(s);
const CONCURRENCY = 3;
const MAX_TRIES = 3; // first try plus two retries for "couldn't check" prices
const DOOR_OPTIONS = [45, 50, 55, 60, 65, 70, 75, 80, 90];
const WALK_OPTIONS = [5, 10, 15].filter((m) => m <= MAX_WALK);
const BUDGETS = Array.from({ length: 23 }, (_, i) => 400000 + i * 50000); // £400k to £1.5m
const TONE_WORD = { great: 'Outstanding', good: 'Good' };

let d; // { api, esc, gbpShort, dist, destName, openPlace, store }
const S = {
  data: null, // /api/find body
  dataFaith: undefined, // faith the data was loaded with
  prices: new Map(), // station id -> /api/find/price body (or { error })
  asked: new Map(), // station id -> budget last requested
  tries: new Map(), // station id -> price requests made
  flood: new Map(), // station id -> /api/flood body (or { error })
  active: 0,
  map: null,
  pins: null,
  fitted: '',
};

const settings = () => ({
  maxDoor: Number($('#fp-door').value),
  maxWalk: Number($('#fp-walk').value),
  budget: Number($('#fp-budget').value),
  faith: $('#fp-faith').value,
});

function fill(sel, values, label, saved, fallback) {
  sel.innerHTML = values.map((v) => `<option value="${v}">${d.esc(label(v))}</option>`).join('');
  sel.value = values.map(String).includes(saved) ? saved : String(fallback);
}

/** Set up the settings bar. Called once from app.js. */
export function initFind(deps) {
  d = deps;
  fill($('#fp-door'), DOOR_OPTIONS, (v) => `${v} min or less`, d.store.get('doorstep.find.maxDoor'), 60);
  fill($('#fp-walk'), WALK_OPTIONS, (v) => `up to ${v} min`, d.store.get('doorstep.find.maxWalk'), 15);
  fill($('#fp-budget'), BUDGETS, (v) => `up to ${d.gbpShort(v)}`, d.store.get('doorstep.find.budget'), 800000);
  $('#fp-faith').innerHTML = $('#school-faith').innerHTML; // same options as the Schools panel
  $('#fp-faith').value = d.store.get('doorstep.faith') || '';

  for (const [id, key] of [['#fp-door', 'maxDoor'], ['#fp-walk', 'maxWalk'], ['#fp-budget', 'budget']]) {
    $(id).addEventListener('change', () => { d.store.set(`doorstep.find.${key}`, $(id).value); draw(); pump(); });
  }
  $('#fp-faith').addEventListener('change', () => {
    d.store.set('doorstep.faith', $('#fp-faith').value);
    $('#school-faith').value = $('#fp-faith').value;
    load();
  });

  $('#fp-list').addEventListener('click', (e) => open(e.target.closest('[data-id]')));
  $('#fp-list').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(e.target.closest('[data-id]')); } });
  $('#fp-unknown').addEventListener('click', (e) => { const a = e.target.closest('[data-id]'); if (a) { e.preventDefault(); open(a); } });
  $('#fp-list').addEventListener('mouseover', (e) => hot(e.target.closest('[data-id]')?.dataset.id));
  $('#fp-list').addEventListener('mouseleave', () => hot(null));
}

function open(row) {
  const st = row && S.data?.stations.find((s) => s.id === row.dataset.id);
  if (st) d.openPlace(st.postcode, st.terminus);
}

/** Show the view; loads the station list the first time, or again if the faith setting changed elsewhere. */
export function showFind() {
  initMap();
  S.map?.invalidateSize();
  $('#fp-faith').value = d.store.get('doorstep.faith') || '';
  if (!S.data || S.dataFaith !== $('#fp-faith').value) load();
  else { S.fitted = ''; draw(); pump(); }
}

async function load() {
  const faith = $('#fp-faith').value;
  S.dataFaith = faith;
  S.data = null;
  $('#fp-progress').innerHTML = '<span class="loading">Finding stations…</span>';
  $('#fp-list').innerHTML = '';
  try {
    const data = await d.api(`/api/find?faith=${encodeURIComponent(faith)}`);
    if (S.dataFaith !== faith) return; // a newer load started
    S.data = data;
  } catch (e) {
    $('#fp-progress').innerHTML = `<span class="error">${d.esc(friendlyError(e))}</span>`;
    return;
  }
  S.fitted = '';
  draw();
  pump();
}

/* ───────── Fetching prices (and flood for matches), fastest trains first ───────── */

function verdictFor(st, set = settings()) {
  const p = S.prices.get(st.id);
  if (!p) return { status: 'pending' };
  const v = priceVerdict(p, { allowanceMin: st.allowanceMin, budget: set.budget });
  return v.status === 'needs-epc' ? { status: 'pending' } : v;
}

function nextJob() {
  if (!S.data?.ready) return null;
  const set = settings();
  const ranked = rankStations(S.data.stations, set);
  for (const st of ranked) {
    const p = S.prices.get(st.id);
    const asked = S.asked.get(st.id);
    if (asked === 'busy') continue;
    if (!p) return { kind: 'price', st };
    // Budget raised past a station the cheap check ruled out: ask again so room counts are checked.
    if (priceVerdict(p, { allowanceMin: st.allowanceMin, budget: set.budget }).status === 'needs-epc' && asked !== set.budget) return { kind: 'price', st };
    if (verdictFor(st, set).status === 'pass' && !S.flood.has(st.id)) return { kind: 'flood', st };
  }
  // Only once everything else is done (less load): retry prices that failed for a passing reason.
  for (const st of ranked) {
    if (S.asked.get(st.id) !== 'busy' && retryable(S.prices.get(st.id)) && (S.tries.get(st.id) || 0) < MAX_TRIES) return { kind: 'price', st };
  }
  return null;
}

function pump() {
  // Only while the view is open: otherwise it competes with the place view's own requests.
  if ($('#find').hidden) return;
  while (S.active < CONCURRENCY) {
    const job = nextJob();
    if (!job) break;
    S.active++;
    run(job).finally(() => { S.active--; draw(); pump(); });
  }
}

async function run({ kind, st }) {
  if (kind === 'flood') {
    S.flood.set(st.id, { pending: true });
    S.flood.set(st.id, await d.api(`/api/flood?lat=${st.lat}&lng=${st.lng}`).catch((e) => ({ error: e.message })));
    return;
  }
  const budget = settings().budget;
  S.asked.set(st.id, 'busy');
  S.tries.set(st.id, (S.tries.get(st.id) || 0) + 1);
  const body = await d.api(`/api/find/price?id=${encodeURIComponent(st.id)}&budget=${budget}`).catch((e) => ({ error: e.message }));
  S.prices.set(st.id, body);
  S.asked.set(st.id, budget);
}

/* ───────── Drawing ───────── */

const dateOf = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const journeyDay = (ymd) => (ymd ? dateOf(`${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`) : '');

function schoolHtml(s, phase) {
  return `<div class="fp-school"><span class="fp-phase">${phase}</span>
    <span class="badge ${d.esc(s.tone)}" title="${d.esc(s.headline)}">${TONE_WORD[s.tone] || ''}</span>
    <span class="fp-sname">${d.esc(s.name)}</span><small>${d.dist(s.distance)} from the station</small></div>`;
}

function floodHtml(id) {
  const f = S.flood.get(id);
  if (!f || f.pending || f.error || !f.ready || !f.verdict) return '';
  return `<span class="chip flood-${d.esc(f.verdict)}" title="Flood risk from rivers and the sea within about 1 km">${d.esc(f.label)}</span>`;
}

function rowHtml(st, n, v) {
  const name = d.esc(d.destName(st.terminus));
  const change = st.changes ? `${st.changes} change${st.changes === 1 ? '' : 's'}${st.changeAt?.length ? ` at ${d.esc(st.changeAt.join(', '))}` : ''}` : 'direct';
  const price = v.status === 'pass'
    ? `<div class="fp-price"><span class="main num">${d.gbpShort(v.median)}</span><small>typical ${v.allSizes ? 'detached or semi (all sizes)' : '4-bed'} · from ${v.count} sales</small></div>`
    : '<div class="fp-price"><span class="loading">checking price…</span></div>';
  return `<li class="fp-row${v.status === 'pass' ? '' : ' pending'}" data-id="${d.esc(st.id)}" tabindex="0" role="button" aria-label="Open ${d.esc(st.name)}">
    ${v.status === 'pass' ? `<span class="fp-num">${n}</span>` : '<span class="fp-num muted">·</span>'}
    <div class="fp-main">
      <h3>${d.esc(st.name)}</h3>
      <p class="fp-commute"><span class="num">${st.trainMin} min</span> to ${name} · ${change}<small>walk up to ${st.allowanceMin} min (${d.dist(st.allowanceMin * 80)})</small></p>
      <div class="fp-schools">${schoolHtml(st.primary, 'Primary')}${schoolHtml(st.secondary, 'Secondary')}</div>
    </div>
    <div class="fp-side">${price}${floodHtml(st.id)}</div>
  </li>`;
}

function draw() {
  if (!S.data || $('#find').hidden) return;
  if (!S.data.ready) {
    $('#fp-progress').innerHTML = `<span class="callout">${d.esc(S.data.message)}</span>`;
    $('#fp-list').innerHTML = '';
    return;
  }
  const set = settings();
  const ranked = rankStations(S.data.stations, set).map((st) => ({ st, v: verdictFor(st, set) }));
  const pass = ranked.filter((r) => r.v.status === 'pass');
  const pending = ranked.filter((r) => r.v.status === 'pending');
  const unknown = ranked.filter((r) => r.v.status === 'unknown');
  const checked = ranked.length - pending.length;
  const over = ranked.filter((r) => r.v.status === 'over').length;
  const overText = over ? ` · ${over} over budget` : '';

  $('#fp-progress').innerHTML = pending.length
    ? `<span class="loading">Checking prices: ${checked} of ${ranked.length} stations${overText}</span>`
    : `<strong>${pass.length} ${pass.length === 1 ? 'place matches' : 'places match'}</strong> <span class="muted">· ${ranked.length} stations checked${overText}</span>`;

  const epcDown = unknown.filter((r) => /energy certificate/.test(r.v.reason)).length;
  $('#fp-banner').innerHTML = epcDown && epcDown >= checked / 2
    ? '<p class="sl-warn">The energy certificate service isn\'t responding, so room counts can\'t be checked. Try again later.</p>'
    : '';

  $('#fp-list').innerHTML = [...pass.map((r, i) => rowHtml(r.st, i + 1, r.v)), ...pending.map((r) => rowHtml(r.st, 0, r.v))].join('')
    || (pending.length ? '' : '<li class="fp-empty">No stations match these settings. Try a longer door-to-door time or a higher budget.</li>');

  const un = $('#fp-unknown');
  un.hidden = !unknown.length;
  $('summary', un).textContent = `Couldn't check the price (${unknown.length})`;
  $('ul', un).innerHTML = unknown.map(({ st, v }) => `<li><a href="#" data-id="${d.esc(st.id)}">${d.esc(st.name)}</a> <small>${d.esc(v.reason)}</small></li>`).join('');

  $('#fp-dates').textContent = `Train times as at ${dateOf(S.data.builtAt)} (planned for ${journeyDay(S.data.journeyDate)}, arriving 09:00)`
    + `${S.data.schoolsAsOf ? ` · Ofsted results as at ${dateOf(S.data.schoolsAsOf)}` : ''} · Sales from the last 3 years`;

  drawPins(pass, ranked);
}

/* ───────── Map ───────── */

function initMap() {
  if (S.map || !window.L) return;
  S.map = L.map('find-map', { scrollWheelZoom: false }).setView([51.5, -0.12], 8);
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(S.map);
  S.pins = L.layerGroup().addTo(S.map);
}

function drawPins(pass, ranked) {
  if (!S.map) return;
  S.pins.clearLayers();
  pass.forEach(({ st }, i) => {
    const icon = L.divIcon({ className: '', html: `<span class="fp-pin" data-pin="${d.esc(st.id)}">${i + 1}</span>`, iconSize: [26, 26], iconAnchor: [13, 13] });
    L.marker([st.lat, st.lng], { icon, title: st.name })
      .on('mouseover', () => hot(st.id))
      .on('mouseout', () => hot(null))
      .on('click', () => d.openPlace(st.postcode, st.terminus))
      .addTo(S.pins);
  });
  // Fit to every candidate once per search, so the map doesn't jump as prices fill in.
  const key = ranked.map((r) => r.st.id).join();
  if (key && key !== S.fitted) {
    S.fitted = key;
    S.map.fitBounds(L.latLngBounds(ranked.map((r) => [r.st.lat, r.st.lng])), { padding: [24, 24], maxZoom: 12 });
  }
}

function hot(id) {
  for (const el of document.querySelectorAll('#find .hot')) el.classList.remove('hot');
  if (!id) return;
  document.querySelector(`#fp-list [data-id="${CSS.escape(id)}"]`)?.classList.add('hot');
  document.querySelector(`#find-map [data-pin="${CSS.escape(id)}"]`)?.classList.add('hot');
}
