const $ = (s, el = document) => el.querySelector(s);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const gbp = (n) => (n == null ? '–' : '£' + Math.round(n).toLocaleString('en-GB'));
const gbpShort = (n) => (n == null ? '–' : n >= 1e6 ? `£${(n / 1e6).toFixed(2).replace(/0$/, '')}m` : `£${Math.round(n / 1000)}k`);
const dist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(1)} mi`);
const monthName = (iso) => new Date(iso + (iso.length === 7 ? '-01' : '')).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
const dayName = (iso) => new Date(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
const fullDate = (iso) => new Date(iso).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
const daysSince = (iso) => Math.floor((Date.now() - new Date(iso)) / 864e5);
const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const state = {
  place: null,
  config: null,
  schools: null,
  transport: null,
  prices: null,
  crime: null,
  flood: null,
  floodLayer: 'rivers',
  schoolPhase: 'all',
  priceType: 'all',
  showAllSales: false,
  showAllSchools: false,
};

async function api(path) {
  const res = await fetch(path);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const loading = (msg) => `<p class="loading">${esc(msg)}</p>`;
const errorBox = (e) => `<p class="error">${esc(e.message || e)}</p>`;

/* ───────────── Map ───────────── */

let map, layer, crimeLayer, floodLayers;
const FLOOD_MIN_ZOOM = 14;
function initMap() {
  if (map || !window.L) return;
  map = L.map('map', { scrollWheelZoom: false });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
  }).addTo(map);
  // Environment Agency flood maps (England). Both use the same blues, so only one is shown at a time.
  const EA = 'https://environment.data.gov.uk/spatialdata';
  // The EA only draws these at about 1:50,000 or closer, which is zoom 14 and up.
  const wms = (svc, layers) => L.tileLayer.wms(`${EA}/${svc}/wms`, { layers, format: 'image/png', transparent: true, opacity: 0.65, version: '1.3.0', minZoom: FLOOD_MIN_ZOOM, attribution: 'Flood risk © Environment Agency' });
  floodLayers = {
    rivers: wms('nafra2-risk-of-flooding-from-rivers-and-sea', 'rofrs_4band'),
    surface: wms('nafra2-risk-of-flooding-from-surface-water', 'rofsw'),
  };
  crimeLayer = L.layerGroup().addTo(map);
  layer = L.layerGroup().addTo(map);
  map.on('zoomend', floodZoomHint);
}

const toneColour = (tone) => getComputedStyle(document.documentElement).getPropertyValue(`--${tone || 'none'}`).trim();

function drawMap() {
  if (!map || !state.place) return;
  layer.clearLayers();
  const { lat, lng } = state.place;
  const ink = getComputedStyle(document.documentElement).getPropertyValue('--ink').trim();
  L.circleMarker([lat, lng], { radius: 8, color: '#fff', weight: 2, fillColor: ink, fillOpacity: 1 })
    .bindPopup(`<strong>${esc(state.place.label)}</strong>`).addTo(layer);
  const pts = [[lat, lng]];

  const accent = toneColour('accent');
  for (const s of visibleSchools()) {
    const good = goodChance(s);
    if (good) {
      // Halo for schools you're likely to get into.
      L.circleMarker([s.lat, s.lng], { radius: 11, color: accent, weight: 3, fill: false, interactive: false }).addTo(layer);
    }
    L.circleMarker([s.lat, s.lng], { radius: good ? 7 : 6, color: '#fff', weight: 1.5, fillColor: toneColour(s.rating.tone), fillOpacity: 0.95 })
      .bindPopup(`<strong>${esc(s.name)}</strong><br>${esc(s.phase || '')} · ${esc(s.rating.headline)}<br>${dist(s.distance)} away${s.catchment ? `<br>Catchment: <strong>${esc(s.catchment.label)}</strong>${s.catchment.official ? '' : ' (estimate)'}` : ''}`)
      .addTo(layer);
    pts.push([s.lat, s.lng]);
  }
  for (const st of state.transport?.stations || []) {
    const icon = L.divIcon({ className: '', html: `<span style="display:block;width:14px;height:14px;border-radius:3px;background:${toneColour('station')};border:2px solid #fff;box-shadow:0 0 0 1px rgba(0,0,0,.25)"></span>`, iconSize: [14, 14] });
    L.marker([st.lat, st.lng], { icon }).bindPopup(`<strong>${esc(st.name)}</strong><br>${dist(st.distance)} away`).addTo(layer);
    pts.push([st.lat, st.lng]);
  }
  map.fitBounds(L.latLngBounds(pts).pad(0.12), { maxZoom: 15 });
}

/* ───────────── At a glance ───────────── */

function drawGlance() {
  const items = [];
  const t = state.transport;
  if (t && !t.error) {
    const st = t.stations[0];
    items.push(['Nearest station', st ? esc(st.name) : 'None nearby', st ? `${dist(st.distance)} away` : '']);
    const d = t.doorToDoor;
    items.push([`Door to ${esc(t.destination.split(' (')[0])}`, d?.minutes ? `${d.minutes} min` : '–', 'arriving 09:00 on a weekday']);
  }
  const p = state.prices;
  if (p && !p.error) {
    const sales = filteredSales(p, 'all');
    for (const type of ['Detached', 'Semi-detached']) {
      const list = sales.filter((s) => s.type === type);
      items.push([`Median ${type.toLowerCase()}`, list.length ? gbpShort(median(list.map((s) => s.price))) : '–', `${list.length} sale${list.length === 1 ? '' : 's'}${sizeFilterLabel()}`]);
    }
  }
  const c = state.crime;
  if (c && !c.error && c.monthsCounted) {
    items.push(['Crimes per month', Math.round(c.total / c.monthsCounted).toLocaleString('en-GB'), 'within about a mile']);
  }
  const f = state.flood;
  if (f?.ready) {
    items.push(['Flood risk', f.covered ? esc(f.label) : '–', f.covered ? `${f.medHigh.toLocaleString('en-GB')} homes at medium/high risk nearby` : 'no data for Wales']);
  }
  const sc = state.schools;
  if (sc?.ready) {
    const near = sc.schools.filter((s) => goodChance(s) && (s.rating.tone === 'great' || s.rating.tone === 'good'));
    items.push(['Likely school places', String(near.length), 'good or better, estimated']);
  }
  $('#glance').innerHTML = items.map(([k, v, small]) => `<div><dt>${k}</dt><dd>${v}<small>${small}</small></dd></div>`).join('');
}

/* ───────────── Transport ───────────── */

function legHtml(l) {
  const label = l.mode === 'walking' ? `walk ${l.minutes}m`
    : l.mode === 'national-rail' ? (l.line ? `${l.line}` : 'train')
    : l.mode === 'tube' ? `${l.line || 'Tube'}`
    : l.line || l.mode;
  return `<span class="leg ${esc(l.mode)}" title="${esc(l.summary || '')}">${esc(label)}</span>`;
}

function journeyRoute(j) {
  return j.legs.filter((l) => !(l.mode === 'walking' && l.minutes <= 2)).map(legHtml).join('<span aria-hidden="true">›</span>');
}

const MODE_NAME = { 'national-rail': 'Train', tube: 'Tube', overground: 'Overground', 'elizabeth-line': 'Elizabeth line', dlr: 'DLR', bus: 'Bus', coach: 'Coach', tram: 'Tram', 'river-bus': 'River bus', walking: 'Walk' };

function changesText(j) {
  if (!j.changes) return 'direct';
  return `${j.changes} change${j.changes === 1 ? '' : 's'} at ${j.changeAt.map(esc).join(', ')}`;
}

/** Step-by-step timeline: board here, ride this line, change there, arrive. */
function journeySteps(j, destination) {
  const rows = [];
  j.legs.forEach((l, i) => {
    if (l.mode === 'walking') {
      if (l.minutes <= 1) return;
      const next = j.legs[i + 1];
      const where = next ? next.from : destination;
      rows.push(`<li class="step walk"><span class="t">${esc(l.departs || '')}</span><span class="node"></span><div>Walk ${l.minutes} min${where ? ` to <strong>${esc(where)}</strong>` : ''}</div></li>`);
      return;
    }
    const prev = j.legs.slice(0, i).reverse().find((x) => x.mode !== 'walking');
    const isChange = Boolean(prev);
    const service = [l.line && l.line !== MODE_NAME[l.mode] ? l.line : null, MODE_NAME[l.mode] || l.mode].filter(Boolean).join(' ');
    rows.push(`<li class="step ride ${esc(l.mode)}">
        <span class="t">${esc(l.departs || '')}</span><span class="node"></span>
        <div>
          ${isChange ? `<span class="change-tag">Change</span> ` : ''}<strong>${esc(l.from)}</strong>
          <div class="ride-line">${esc(service)}${l.towards ? ` towards ${esc(l.towards)}` : ''}</div>
          <div class="ride-meta">${l.minutes} min${l.stops > 1 ? ` · ${l.stops} stops` : ''} · get off at <strong>${esc(l.to)}</strong>${l.disrupted ? ' · <span class="warn">disruption reported</span>' : ''}</div>
        </div>
      </li>`);
  });
  rows.push(`<li class="step end"><span class="t">${esc(j.arrives || '')}</span><span class="node"></span><div>Arrive <strong>${esc(destination)}</strong></div></li>`);
  return `<ol class="steps-list">${rows.join('')}</ol>`;
}

function journeyBlock(j, destination, id) {
  const open = state.openJourney === id;
  return `<div class="route">${journeyRoute(j)}</div>
    <button type="button" class="steps-toggle" data-jid="${esc(id)}" aria-expanded="${open}">${open ? 'Hide' : 'Show'} steps · ${changesText(j)}</button>
    <div class="steps-wrap${open ? ' open' : ''}"${open ? '' : ' inert'}><div class="steps-inner">${journeySteps(j, destination)}</div></div>`;
}

function drawTransport() {
  const body = $('#transport-body');
  const t = state.transport;
  if (!t) return (body.innerHTML = loading('Planning journeys with TfL…'));
  if (t.error) return (body.innerHTML = errorBox(t.error));
  const tdate = `${t.date.slice(0, 4)}-${t.date.slice(4, 6)}-${t.date.slice(6, 8)}`;
  $('#transport-sub').textContent = `Fastest journey to ${t.destination}, arriving by 09:00 · TfL timetable for ${fullDate(tdate)}`;
  const dest = t.destination.split(' (')[0];
  const d = t.doorToDoor;
  let html = '';
  if (d && !d.error) {
    html += `<div class="door"><div class="door-head"><span class="big">${d.minutes} min</span><span>door to door · leave ${esc(d.departs)} · ${d.changes ? `${d.changes} change${d.changes === 1 ? '' : 's'}` : 'direct'}</span></div>${journeyBlock(d, dest, 'door')}</div>`;
  } else if (d?.error) {
    html += `<p class="note">Couldn't plan a door-to-door journey: ${esc(d.error)}</p>`;
  }
  if (!t.stations.length) {
    html += '<p class="note">No rail, Tube or DLR stations within 10 km.</p>';
  } else {
    html += '<div class="stations">' + t.stations.map((s, i) => {
      const j = s.toLondon;
      const mins = j && !j.error ? `${j.minutes} min<small>from the station</small>` : '–<small>no journey found</small>';
      return `<div class="station">
        <div><h3>${esc(s.name)}</h3><span class="school-meta">${dist(s.distance)} away · ${esc((s.modes || []).join(', ').replace(/-/g, ' '))}</span></div>
        <div class="mins">${mins}</div>
        ${j && !j.error ? `<div class="station-journey">${journeyBlock(j, dest, `st${i}`)}</div>` : ''}
      </div>`;
    }).join('') + '</div>';
  }
  html += '<p class="note">Times come from the TfL Journey Planner for next Tuesday, so they reflect timetabled services rather than live delays.</p>';
  body.innerHTML = html;
  for (const b of body.querySelectorAll('.steps-toggle')) {
    b.addEventListener('click', () => {
      const id = b.dataset.jid;
      state.openJourney = state.openJourney === id ? null : id;
      for (const other of body.querySelectorAll('.steps-toggle')) {
        const on = other.dataset.jid === state.openJourney;
        const wrap = other.nextElementSibling;
        other.setAttribute('aria-expanded', String(on));
        other.textContent = other.textContent.replace(/^(Show|Hide)/, on ? 'Hide' : 'Show');
        wrap.classList.toggle('open', on);
        if (on) wrap.removeAttribute('inert'); else wrap.setAttribute('inert', '');
      }
    });
  }
}

/* ───────────── Schools ───────────── */

const CHANCE_ORDER = { in: 0, likely: 1, possible: 2, faith: 3, selective: 4, unlikely: 5, out: 6, special: 7, na: 8 };
const chance = (s) => s.catchment?.estimate || s.catchment?.status || 'na';
const goodChance = (s) => ['in', 'likely'].includes(chance(s));

const NO_FAITH_VALUES = ['Does not apply', 'None', 'Unknown', null, undefined, ''];
const isFaithSchool = (s) => !NO_FAITH_VALUES.includes(s.religion);

function schoolsUrl() {
  const { lat, lng } = state.place;
  const faith = $('#school-faith').value;
  return `/api/schools?lat=${lat}&lng=${lng}&radius=5000${faith ? `&faith=${encodeURIComponent(faith)}` : ''}`;
}

function visibleSchools() {
  const sc = state.schools;
  if (!sc?.ready) return [];
  const radius = Number($('#school-radius').value);
  let list = sc.schools.filter((s) => s.distance <= radius);
  if ($('#school-hide-faith').checked) list = list.filter((s) => !isFaithSchool(s));
  if (state.schoolPhase === 'Primary') list = list.filter((s) => s.phase === 'Primary' || s.phase === 'Nursery');
  else if (state.schoolPhase === 'Secondary') list = list.filter((s) => s.phase === 'Secondary');
  else if (state.schoolPhase === 'other') list = list.filter((s) => !['Primary', 'Secondary', 'Nursery'].includes(s.phase));
  const sort = $('#school-sort').value;
  if (sort === 'rating') list = [...list].sort((a, b) => (b.rating.score ?? -1) - (a.rating.score ?? -1) || a.distance - b.distance);
  if (sort === 'chance') list = [...list].sort((a, b) => CHANCE_ORDER[chance(a)] - CHANCE_ORDER[chance(b)] || (b.rating.score ?? -1) - (a.rating.score ?? -1));
  return list;
}

/** Describe the school by type, e.g. "First school", "Middle school", from phase + age range. */
function schoolKind(s) {
  const [lo, hi] = String(s.ages || '').split(/[–-]/).map(Number);
  if (s.phase === 'Nursery') return 'Nursery';
  if (s.phase === 'Special') return 'Special school';
  if (s.phase === 'Alternative provision') return 'Alternative provision';
  if (!lo || !hi) return s.phase ? `${s.phase} school` : 'School';
  if (lo <= 5 && hi >= 14) return 'All-through school';
  if (lo >= 13) return 'Upper school';
  if (lo >= 8 && hi <= 14) return 'Middle school';
  if (s.phase === 'Secondary') return 'Secondary school';
  if (lo >= 7) return 'Junior school';
  if (hi <= 7) return 'Infant school';
  if (hi <= 10) return 'First school';
  return 'Primary school';
}

const fmtDist = (m) => (m < 1000 ? `${Math.round(m / 10) * 10} m` : `${(m / 1609.34).toFixed(2)} mi`);
const ordinalWord = (n) => ['', 'nearest', '2nd nearest', '3rd nearest'][n] || `${n}th nearest`;

/** "Possible · faith priority" -> ["Possible", "faith priority"] */
const splitLabel = (label) => { const [head, ...rest] = String(label || '–').split(' · '); return [head, rest.join(' · ')]; };

function chipHtml(s, c) {
  const [head, tags] = splitLabel(c.label);
  const sub = [tags, c.official ? 'your figure' : ''].filter(Boolean).join(' · ');
  return `<span class="chip ${esc(chance(s))}" title="${esc(c.detail || '')}">${esc(head)}</span>${sub ? `<small class="chip-sub">${esc(sub)}</small>` : ''}`;
}

function catchmentReason(s) {
  const c = s.catchment;
  const kind = schoolKind(s).toLowerCase();
  const sex = /girls'?/i.test(s.name) ? ' for girls' : /boys'?/i.test(s.name) ? ' for boys' : '';
  if (c.official) return `You're ${fmtDist(s.distance)} away · cut-off ${fmtDist(c.lastOffered)}${c.note ? ` (${c.note})` : ''}`;
  if (c.status === 'selective') return 'Grammar school: places go by 11+ result first, then usually distance';
  const parts = [`${c.rank ? ordinalWord(c.rank).replace(/^./, (x) => x.toUpperCase()) : 'Nearby'} ${kind}${sex}`, fmtDist(s.distance)];
  if (c.faithNote) parts.push(c.faithNote);
  return parts.join(' · ');
}

function catchmentMeter(s) {
  const c = s.catchment;
  if (!c.official) return '';
  const max = Math.max(s.distance, c.lastOffered) * 1.18;
  const home = (s.distance / max) * 100;
  const cut = (c.lastOffered / max) * 100;
  const diff = Math.abs(c.lastOffered - s.distance);
  const inside = s.distance <= c.lastOffered;
  return `<div class="meter ${inside ? 'in' : 'out'}" role="img" aria-label="Your distance ${fmtDist(s.distance)}, cut-off ${fmtDist(c.lastOffered)}">
      <div class="meter-track"><div class="meter-fill" style="width:${home}%"></div><div class="meter-cut" style="left:${cut}%"></div><div class="meter-home" style="left:${home}%"></div></div>
      <div class="meter-labels"><span>School</span>${Math.abs(cut - home) > 16 ? `<span class="meter-cut-label" style="left:${home}%">You</span>` : ''}<span class="meter-cut-label" style="left:${cut}%">Cut-off</span></div>
      <p class="meter-verdict">${inside ? 'Inside' : 'Outside'} by ${fmtDist(diff)}</p>
    </div>`;
}

function catchmentForm(s) {
  const c = s.catchment;
  if (!c || ['special', 'na'].includes(c.status)) return c ? `<p class="note">${esc(c.detail)}</p>` : '';
  const saved = c.lastOffered;
  const year = new Date().getFullYear();
  const savedYear = (c.note || '').match(/\d{4}/)?.[0];
  const years = [year + 1, year, year - 1, year - 2, year - 3];
  const search = `https://www.google.com/search?q=${encodeURIComponent(`${s.name} ${s.la || ''} last distance offered`.replace(/\s+/g, ' ').trim())}`;
  return `<div class="catch-box">
      <div class="catch-head">
        <span class="catch-title">Catchment</span>
        <span class="chip ${esc(chance(s))}">${esc(splitLabel(c.label)[0])}</span>
        <span class="catch-src">${c.official ? 'your figure' : 'estimate'}</span>
      </div>
      <p class="catch-why" title="${esc(c.detail)}">${esc(catchmentReason(s))}</p>
      ${catchmentMeter(s)}
      <form class="catch-form" data-urn="${esc(s.urn)}">
        <label for="lo-${esc(s.urn)}">${saved ? 'Update last distance offered' : 'Last distance offered'}</label>
        <div class="catch-row">
          <input id="lo-${esc(s.urn)}" name="value" type="number" step="any" min="0" inputmode="decimal" placeholder="0.62" value="${saved ? (saved / 1609.34).toFixed(3).replace(/\.?0+$/, '') : ''}">
          <select name="unit" aria-label="Unit"><option value="mi">miles</option><option value="m">metres</option><option value="km">km</option></select>
          <select name="year" aria-label="Entry year"><option value="">Year</option>${years.map((y) => `<option value="${y}"${String(y) === savedYear ? ' selected' : ''}>${y}</option>`).join('')}</select>
          <button type="submit">Save</button>
          ${saved ? '<button type="button" class="link" data-clear>Clear</button>' : ''}
        </div>
      </form>
      <a class="catch-link" href="${esc(search)}" target="_blank" rel="noopener">Find this school's last distance offered ↗</a>
    </div>`;
}

function drawSchools() {
  const body = $('#schools-body');
  const sc = state.schools;
  if (!sc) return (body.innerHTML = loading('Finding schools…'));
  if (sc.error) return (body.innerHTML = errorBox(sc.error));
  if (!sc.ready) {
    body.innerHTML = `<div class="callout">${esc(sc.message)}<br>In a terminal: <code>cd ~/Developer/doorstep &amp;&amp; npm run setup</code></div>`;
    return;
  }
  const asAt = (sc.source || '').match(/as at (.+)$/i)?.[1];
  const age = sc.builtAt ? daysSince(sc.builtAt) : 0;
  $('#schools-sub').innerHTML = `Ofsted results as at ${esc(asAt || 'unknown date')} · downloaded ${sc.builtAt ? esc(dayName(sc.builtAt)) : '–'}`
    + (age > 45 ? ' · <strong>over a month old: run <code>npm run setup</code> to refresh</strong>' : '');
  const list = visibleSchools();
  if (!list.length) {
    body.innerHTML = '<p class="note">No state-funded schools of this type in range. Try a wider radius.</p>';
    return;
  }

  // Summary of the schools you have the best chance at.
  const best = (phase) => sc.schools.filter((s) => s.phase === phase && goodChance(s)).sort((a, b) => a.distance - b.distance);
  const summary = ['Primary', 'Secondary'].map((p) => {
    const l = best(p);
    return `<div><span class="school-meta">${p}</span><br>${l.length ? l.slice(0, 3).map((s) => `<strong>${esc(s.name)}</strong> <span class="badge ${esc(s.rating.tone)} inline">${esc(shortRating(s.rating))}</span>`).join('<br>') : '<span class="school-meta">None looks likely. Check the council\'s figures.</span>'}</div>`;
  }).join('');

  const shown = state.showAllSchools ? list : list.slice(0, 12);
  const rows = shown.map((s) => {
    const r = s.rating;
    const c = s.catchment || { status: 'na', label: '–' };
    const when = r.date ? `${r.system} · ${monthName(r.date)}` : r.system || '';
    const areas = r.areas.length
      ? `<div class="areas">${r.areas.map((a) => `<div>${esc(a.label)}: <span>${esc(a.grade)}</span></div>`).join('')}${r.safeguarding ? `<div>Safeguarding: <span>${esc(r.safeguarding)}</span></div>` : ''}</div>`
      : '';
    const open = state.openUrn === s.urn;
    const faithName = s.religion && !['Does not apply', 'None', 'Unknown'].includes(s.religion) ? s.religion : null;
    const facts = [when, s.pupils ? `${s.pupils.toLocaleString('en-GB')} pupils` : null, faithName, s.admissions === 'Selective' ? 'Selective (grammar)' : null].filter(Boolean);
    const ofsted = `${facts.length ? `<p class="facts">${facts.map(esc).join(' · ')}</p>` : ''}${areas}${r.note ? `<p class="note">${esc(r.note)}</p>` : ''}${s.link ? `<p class="note"><a href="${esc(s.link)}" target="_blank" rel="noopener">Ofsted reports ↗</a></p>` : ''}`;
    const hasRating = r.areas.length > 0;
    return `<tr class="school-row${goodChance(s) ? ' hl' : ''}${open ? ' is-open' : ''}" data-urn="${esc(s.urn)}">
      <td>
        <button type="button" class="school-toggle" aria-expanded="${open}" aria-controls="more-${esc(s.urn)}">
          <span class="school-name">${esc(s.name)}</span><br>
          <span class="school-meta">${esc(schoolKind(s))}${s.ages ? ` · ages ${esc(s.ages)}` : ''}</span>
        </button>
      </td>
      <td><div class="badge-wrap"><span class="badge ${esc(r.tone)}">${esc(r.headline)}</span>${r.date ? `<small>${esc(monthName(r.date))}</small>` : ''}</div></td>
      <td>${chipHtml(s, c)}</td>
      <td class="num">${dist(s.distance)}</td>
    </tr>
    <tr class="more-row${goodChance(s) ? ' hl' : ''}${open ? ' open' : ''}" id="more-${esc(s.urn)}"${open ? '' : ' inert'}><td colspan="4">
      <div class="more-anim"><div class="more-inner">
        <div class="more-grid${hasRating ? ' two-col' : ''}">
          ${hasRating ? `<div class="more-ofsted"><p class="eyebrow">Ofsted grades</p>${ofsted}</div>` : ''}
          <div class="more-catch">${catchmentForm(s)}${hasRating ? '' : ofsted}</div>
        </div>
      </div></div>
    </td></tr>`;
  }).join('');
  body.innerHTML = `
    <div class="catch-summary">
      <p class="eyebrow">Best chance of a place</p>
      <div class="catch-cols">${summary}</div>
    </div>
    <div class="table-wrap"><table class="schools">
      <colgroup><col class="c-name"><col class="c-ofsted"><col class="c-catch"><col class="c-dist"></colgroup>
      <thead><tr><th>School</th><th>Latest Ofsted</th><th>Catchment</th><th class="num">Distance</th></tr></thead>
      <tbody>${rows}</tbody></table></div>
    ${list.length > 12 ? `<button class="more" type="button" id="schools-more">${state.showAllSchools ? 'Show fewer' : `Show all ${list.length}`}</button>` : ''}
    <p class="note">Catchment is an estimate from straight-line distance and how many schools of the same type are closer. Siblings, faith and other criteria come first at many schools, and cut-offs change every year. Click a school and enter the council's last distance offered to get a real answer; it's saved on this computer. State-funded schools only.</p>`;

  $('#schools-more')?.addEventListener('click', () => { state.showAllSchools = !state.showAllSchools; drawSchools(); });
  // Click anywhere on a school's row to slide its details open or closed.
  for (const row of body.querySelectorAll('tr.school-row')) {
    row.addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const urn = row.dataset.urn;
      const opening = state.openUrn !== urn;
      for (const other of body.querySelectorAll('tr.school-row.is-open')) {
        other.classList.remove('is-open');
        other.querySelector('.school-toggle').setAttribute('aria-expanded', 'false');
        const m = body.querySelector(`#more-${CSS.escape(other.dataset.urn)}`);
        m?.classList.remove('open');
        m?.setAttribute('inert', '');
      }
      state.openUrn = opening ? urn : null;
      if (opening) {
        row.classList.add('is-open');
        row.querySelector('.school-toggle').setAttribute('aria-expanded', 'true');
        const m = body.querySelector(`#more-${CSS.escape(urn)}`);
        m?.classList.add('open');
        m?.removeAttribute('inert');
      }
    });
  }
  for (const f of body.querySelectorAll('.catch-form')) {
    f.addEventListener('submit', (e) => { e.preventDefault(); saveCatchment(f, false); });
    f.querySelector('[data-clear]')?.addEventListener('click', () => saveCatchment(f, true));
  }
}

function shortRating(r) {
  if (r.system === 'Report card') return 'Report card';
  return r.headline.replace(/ for quality of education$/, '').replace(/^School remains /, '');
}

async function saveCatchment(form, clear) {
  const urn = form.dataset.urn;
  const v = Number(form.value.value);
  const unit = form.unit.value;
  const metres = clear ? null : unit === 'mi' ? v * 1609.34 : unit === 'km' ? v * 1000 : v;
  if (!clear && !(metres > 0)) { form.value.focus(); return; }
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    const res = await fetch('/api/catchment', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urn, metres, note: form.year.value ? `${form.year.value} entry` : '' }) });
    const body = await res.json();
    if (!res.ok) throw new Error(body.error);
    state.openUrn = urn;
    const { lat, lng } = state.place;
    state.schools = await api(schoolsUrl());
    drawSchools();
    drawMap();
    drawGlance();
  } catch (e) {
    btn.disabled = false;
    let p = form.querySelector('.error');
    if (!p) { p = document.createElement('p'); p.className = 'error'; form.append(p); }
    p.textContent = e.message;
  }
}

/* ───────────── Prices ───────────── */

function sizeFilterLabel() {
  if (!state.prices?.epc?.enabled) return '';
  const v = Number($('#price-size').value);
  return v ? ` · ${v}+ rooms` : '';
}

function filteredSales(p, typeOverride) {
  const type = typeOverride ?? state.priceType;
  let sales = p.sales;
  if (type !== 'all') sales = sales.filter((s) => s.type === type);
  if (p.epc?.enabled) {
    const min = Number($('#price-size').value);
    if (min) sales = sales.filter((s) => s.habitableRooms >= min);
  }
  return sales;
}

function yearChart(sales) {
  const years = [...new Set(sales.map((s) => s.date.slice(0, 4)))].sort();
  if (!years.length) return '';
  const types = [['Detached', 'bar-det'], ['Semi-detached', 'bar-semi']].filter(([t]) => state.priceType === 'all' || state.priceType === t);
  const data = years.map((y) => types.map(([t]) => median(sales.filter((s) => s.type === t && s.date.startsWith(y)).map((s) => s.price))));
  const max = Math.max(...data.flat().filter(Boolean)) || 1;
  const W = 640, H = 200, padL = 52, padB = 24, padT = 18;
  const step = (W - padL) / years.length;
  const bw = Math.min(64, (step * 0.62) / types.length);
  const nice = Math.ceil(max / 100000) * 100000;
  const y = (v) => padT + (H - padT - padB) * (1 - v / nice);
  let svg = `<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Median sale price by year">`;
  for (let i = 0; i <= 4; i++) {
    const v = (nice / 4) * i;
    svg += `<line class="grid" x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 6}" y="${y(v) + 4}" text-anchor="end">${gbpShort(v).replace('£0k', '£0')}</text>`;
  }
  years.forEach((yr, i) => {
    const cx = padL + step * i + step / 2;
    data[i].forEach((v, k) => {
      if (!v) return;
      const x = cx - (bw * types.length) / 2 + k * bw;
      svg += `<rect class="${types[k][1]}" x="${x + 1}" y="${y(v)}" width="${bw - 2}" height="${y(0) - y(v)}" rx="2"><title>${yr} ${types[k][0]}: ${gbp(v)}</title></rect>`;
      svg += `<text class="val" x="${x + bw / 2}" y="${y(v) - 4}" text-anchor="middle">${gbpShort(v)}</text>`;
    });
    svg += `<text x="${cx}" y="${H - 6}" text-anchor="middle">${yr}</text>`;
  });
  svg += '</svg>';
  const key = types.length > 1 ? '<p class="key"><span><i style="background:var(--accent)"></i>Detached</span><span><i style="background:var(--station)"></i>Semi-detached</span></p>' : '';
  return key + svg;
}

function drawPrices() {
  const body = $('#prices-body');
  const p = state.prices;
  $('#size-wrap').hidden = !p?.epc?.enabled;
  if (!p) return (body.innerHTML = loading('Searching Land Registry sales…'));
  if (p.error) return (body.innerHTML = errorBox(p.error));

  const latest = p.sales[0]?.date;
  $('#prices-sub').textContent = `Land Registry sales since ${monthName(p.since)}` + (latest ? ` · most recent sale recorded ${dayName(latest)}` : '') + ' · new sales appear 2–3 months after completion';
  const sales = filteredSales(p);
  let html = '';
  if (!p.epc?.enabled) {
    html += `<div class="callout">Land Registry doesn't record bedrooms, so this shows every detached and semi-detached sale. To filter for 4-bed houses, add a free EPC token (it gives each home's room count and floor area). See the README for the two-minute setup.</div>`;
  } else if (p.epc.error) {
    html += `<div class="callout">Couldn't reach the EPC service, so room counts are missing: ${esc(p.epc.error)}</div>`;
  } else {
    html += `<div class="callout">Matched ${p.epc.matched} of ${p.epc.total} sales to an energy certificate. "Habitable rooms" counts bedrooms plus living and dining rooms, so a 4-bed house usually has 5 or 6. Sales without a certificate are hidden when a size filter is on.</div>`;
  }

  const stats = ['Detached', 'Semi-detached'].filter((t) => state.priceType === 'all' || state.priceType === t).map((t) => {
    const list = sales.filter((s) => s.type === t).map((s) => s.price);
    return `<div class="stat"><h3>${t}</h3><div class="big">${gbp(median(list))}</div><p>median of ${list.length} sale${list.length === 1 ? '' : 's'}${list.length ? ` · ${gbpShort(Math.min(...list))}–${gbpShort(Math.max(...list))}` : ''}</p></div>`;
  });
  html += `<div class="stats">${stats.join('')}</div>`;
  if (!sales.length) {
    html += '<p class="note">No matching sales. Try a wider area, a longer period, or a different size filter.</p>';
    body.innerHTML = html;
    return;
  }
  html += yearChart(sales);

  const shown = state.showAllSales ? sales : sales.slice(0, 8);
  const epc = p.epc?.enabled && !p.epc.error;
  const title = (t) => t.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase());
  html += `<div class="table-wrap" style="margin-top:18px"><table class="sales">
    <thead><tr><th>Address</th><th>Type</th>${epc ? '<th class="num">Rooms</th><th class="num">Area</th>' : ''}<th class="num">Sold</th><th class="num">Price</th></tr></thead>
    <tbody>${shown.map((s) => `<tr>
      <td><span class="addr">${esc(title([s.saon, s.paon, s.street].filter(Boolean).join(' ')))}</span> <span class="school-meta">${esc(s.postcode)}${s.newBuild ? ' · new build' : ''}</span></td>
      <td><span class="type-tag ${s.type === 'Detached' ? 'det' : 'semi'}">${s.type === 'Semi-detached' ? 'Semi' : 'Detached'}</span></td>
      ${epc ? `<td class="num">${s.habitableRooms ?? '–'}</td><td class="num">${s.floorArea ? `${Math.round(s.floorArea)} m²` : '–'}</td>` : ''}
      <td class="num muted">${new Date(s.date).toLocaleDateString('en-GB', { month: 'short', year: 'numeric' })}</td>
      <td class="num strong">${gbp(s.price)}</td></tr>`).join('')}</tbody></table></div>
    ${sales.length > 8 ? `<button class="more" type="button" id="sales-more">${state.showAllSales ? 'Show fewer' : `Show all ${sales.length} sales`}</button>` : ''}
    <p class="note">Searched ${p.postcodesSearched} postcodes. ${p.excluded ? `${p.excluded} non-market transfers (repossessions, buy-to-let portfolios and similar) are left out.` : ''}</p>`;
  body.innerHTML = html;
  $('#sales-more')?.addEventListener('click', () => { state.showAllSales = !state.showAllSales; drawPrices(); });
}

/* ───────────── Crime ───────────── */

const RINGS = [
  { m: 200, label: 'Within 200 m', short: 'your doorstep' },
  { m: 500, label: 'Within 500 m', short: 'your neighbourhood' },
  { m: 1609, label: 'Within a mile', short: 'the wider area' },
];

function haversine(lat1, lng1, lat2, lng2) {
  const R = 6371000, r = Math.PI / 180;
  const a = Math.sin(((lat2 - lat1) * r) / 2) ** 2 + Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** Reports matching the selected category, each with its distance from the home. */
function crimePoints() {
  const c = state.crime;
  if (!c?.points) return [];
  if (!c._withDist) {
    c._withDist = c.points.map(([lat, lng, cat, street, mi]) => ({ lat, lng, cat, street, mi, d: haversine(c.centre.lat, c.centre.lng, lat, lng) }));
  }
  return state.crimeCat ? c._withDist.filter((p) => p.cat === state.crimeCat) : c._withDist;
}

/**
 * Compare the home with other places in the wider area.
 * Lay a grid over the mile circle, count reports within the same radius of each grid point,
 * ignore grid points with none nearby (fields, parks, empty land), and see where the home ranks.
 */
function ringStats(points, months) {
  const c = state.crime;
  const lat0 = c.centre.lat, lng0 = c.centre.lng;
  const kx = 111320 * Math.cos((lat0 * Math.PI) / 180), ky = 110540;
  const xy = points.map((p) => [(p.lng - lng0) * kx, (p.lat - lat0) * ky]);
  const countNear = (x, y, r) => { let n = 0; const r2 = r * r; for (const [px, py] of xy) { const dx = px - x, dy = py - y; if (dx * dx + dy * dy <= r2) n++; } return n; };
  return RINGS.map((ring) => {
    const n = points.filter((p) => p.d <= ring.m).length;
    let compare = null;
    if (ring.m < 1609) {
      const reach = 1609 - ring.m;
      const step = ring.m <= 200 ? 140 : 220;
      const samples = [];
      for (let x = -reach; x <= reach; x += step) {
        for (let y = -reach; y <= reach; y += step) {
          if (x * x + y * y > reach * reach) continue;
          const k = countNear(x, y, ring.m);
          if (k > 0) samples.push(k);
        }
      }
      if (n === 0) compare = { tone: 'good', text: 'none reported' };
      else if (samples.length < 8) compare = null;
      else {
        const busier = Math.round((100 * samples.filter((k) => k < n).length) / samples.length);
        compare = busier >= 50
          ? { tone: busier >= 75 ? 'poor' : 'mixed', text: `busier than ${busier}% of the area` }
          : { tone: 'good', text: `quieter than ${100 - busier}% of the area` };
      }
    }
    return { ...ring, n, perMonth: n / months, compare };
  });
}

function trendHtml() {
  const c = state.crime;
  if (!c.previous) return '<span class="trend none">Not enough history for a year-on-year comparison</span>';
  const now = state.crimeCat ? c.categories.find((k) => k.category === state.crimeCat)?.count || 0 : c.total;
  const before = state.crimeCat ? c.previous.byCat[state.crimeCat] || 0 : c.previous.total;
  if (!before) return '<span class="trend none">None in the previous 12 months</span>';
  const pct = Math.round(((now - before) / before) * 100);
  const dir = pct < -2 ? 'down' : pct > 2 ? 'up' : 'flat';
  const arrow = { down: '↓', up: '↑', flat: '→' }[dir];
  const words = dir === 'flat' ? 'about the same as' : `${Math.abs(pct)}% ${dir === 'down' ? 'lower than' : 'higher than'}`;
  return `<span class="trend ${dir}">${arrow} ${words} the previous 12 months <small>(${before.toLocaleString('en-GB')} then)</small></span>`;
}

function drawCrime() {
  const body = $('#crime-body');
  const c = state.crime;
  if (!c) return (body.innerHTML = loading('Loading police data…'));
  if (c.error) return (body.innerHTML = errorBox(c.error));
  if (!c.monthsCounted) return (body.innerHTML = '<p class="note">Police data isn\'t available for this area right now.</p>');

  const months = c.months.filter((m) => m.total != null);
  const first = months[0]?.month, last = months[months.length - 1]?.month;
  $('#crime-sub').textContent = `Street-level reports around the address · ${first ? monthName(first) : ''} to ${last ? monthName(last) : '–'} (police data runs about two months behind)`;

  const pts = crimePoints();
  const catLabel = state.crimeCat ? c.labels[state.crimeCat] : 'All crime';
  const rings = ringStats(pts, c.monthsCounted);

  // Rings: doorstep vs wider area
  const ringHtml = rings.map((r) => `<div class="ring">
      <h3>${r.label}</h3>
      <div class="big">${r.perMonth < 10 ? r.perMonth.toFixed(1).replace(/\.0$/, '') : Math.round(r.perMonth)}<small> a month</small></div>
      <p>${r.compare ? `<span class="ring-tag ${r.compare.tone}" title="Compared with other spots within a mile where crime is reported, using the same size circle">${r.compare.text}</span>` : `${r.n.toLocaleString('en-GB')} in 12 months`}</p>
    </div>`).join('');

  // Monthly chart (filtered)
  const counts = months.map((m, i) => (state.crimeCat ? pts.filter((p) => p.mi === c.months.indexOf(m)).length : m.total));
  const max = Math.max(...counts, 1);
  const W = 640, H = 150, padB = 22, padT = 18;
  const step = W / months.length;
  let svg = `<svg class="chart crime-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(catLabel)} reported per month">`;
  months.forEach((m, i) => {
    const v = counts[i];
    const h = ((H - padB - padT) * v) / max;
    const x = step * i + 4;
    const lastBar = i === months.length - 1;
    svg += `<rect class="hit" data-i="${i}" x="${step * i}" y="0" width="${step}" height="${H - padB}" fill="transparent"></rect>`;
    svg += `<rect class="bar-crime${lastBar ? ' latest' : ''}" data-i="${i}" x="${x}" y="${H - padB - h}" width="${step - 8}" height="${Math.max(h, v ? 1 : 0)}" rx="3"></rect>`;
    svg += `<text class="val${lastBar ? ' strong' : ''}" x="${x + (step - 8) / 2}" y="${H - padB - h - 5}" text-anchor="middle">${v}</text>`;
    svg += `<text x="${x + (step - 8) / 2}" y="${H - 6}" text-anchor="middle">${new Date(m.month + '-01').toLocaleDateString('en-GB', { month: 'short' })}</text>`;
  });
  svg += '</svg>';

  // Category filter buttons (always counts for all crime, so you can see the mix)
  const cmax = c.categories[0]?.count || 1;
  const cats = c.categories.map((k) => `<button type="button" class="hbar cat-btn${state.crimeCat === k.category ? ' active' : ''}" data-cat="${esc(k.category)}" aria-pressed="${state.crimeCat === k.category}">
      <span>${esc(k.label)}</span><span class="track"><span class="fill" style="width:${(100 * k.count) / cmax}%"></span></span><span class="n">${k.count}</span></button>`).join('');

  // Streets (filtered)
  const streetCounts = {};
  for (const p of pts) if (p.street) streetCounts[p.street] = (streetCounts[p.street] || 0) + 1;
  const streets = Object.entries(streetCounts).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const hmax = streets[0]?.[1] || 1;
  const hot = streets.length
    ? streets.map(([st, n]) => `<div class="hbar"><span>${esc(st)}</span><span class="track"><span class="fill" style="width:${(100 * n) / hmax}%;background:var(--mixed)"></span></span><span class="n">${n}</span></div>`).join('')
    : '<p class="note">None reported.</p>';

  body.innerHTML = `
    <div class="crime-filter">
      <span>Showing <strong>${esc(catLabel)}</strong></span>
      ${state.crimeCat ? '<button type="button" class="link-btn" id="crime-clear">Show all crime</button>' : '<span class="school-meta">Pick a type below to filter</span>'}
    </div>
    <div class="rings">${ringHtml}</div>
    <p class="trend-line">${trendHtml()}</p>
    <div class="crime-chart-wrap">${svg}<div class="crime-tip" hidden></div></div>
    <div class="two">
      <div><h3>By type <span class="school-meta">· click to filter</span></h3><div class="hbars">${cats}</div></div>
      <div><h3>Most reported streets${state.crimeCat ? ` · ${esc(catLabel.toLowerCase())}` : ''}</h3><div class="hbars">${hot}</div></div>
    </div>
    <p class="note">Police place each report "on or near" a street to protect privacy, so locations are approximate. Busy streets, stations and shops attract more reports, so compare your doorstep with the wider area rather than reading one number alone.</p>`;

  for (const b of body.querySelectorAll('.cat-btn')) {
    b.addEventListener('click', () => {
      state.crimeCat = state.crimeCat === b.dataset.cat ? null : b.dataset.cat;
      drawCrime();
      drawCrimeMap();
    });
  }
  $('#crime-clear')?.addEventListener('click', () => { state.crimeCat = null; drawCrime(); drawCrimeMap(); });

  // Hover (or tap) a month to see what was reported
  const wrap = body.querySelector('.crime-chart-wrap');
  const tip = wrap.querySelector('.crime-tip');
  const show = (i) => {
    const m = months[i];
    const inMonth = pts.filter((p) => p.mi === c.months.indexOf(m));
    const byCat = {};
    for (const p of inMonth) byCat[p.cat] = (byCat[p.cat] || 0) + 1;
    const top = Object.entries(byCat).sort((a, b) => b[1] - a[1]).slice(0, 4);
    tip.innerHTML = `<strong>${esc(monthName(m.month))}</strong> · ${counts[i]} ${state.crimeCat ? esc(catLabel.toLowerCase()) : 'reports'}`
      + (state.crimeCat ? '' : `<ul>${top.map(([k, n]) => `<li><span>${esc(c.labels[k] || k)}</span><span>${n}</span></li>`).join('')}</ul>`);
    tip.hidden = false;
    const bar = wrap.querySelector(`.bar-crime[data-i="${i}"]`).getBoundingClientRect();
    const box = wrap.getBoundingClientRect();
    const left = Math.min(Math.max(bar.left - box.left + bar.width / 2 - tip.offsetWidth / 2, 0), box.width - tip.offsetWidth);
    tip.style.left = `${left}px`;
    tip.style.top = `${Math.max(bar.top - box.top - tip.offsetHeight - 8, 0)}px`;
    for (const r of wrap.querySelectorAll('.bar-crime')) r.classList.toggle('hover', r.dataset.i === String(i));
  };
  for (const r of wrap.querySelectorAll('rect[data-i]')) {
    r.addEventListener('mouseenter', () => show(Number(r.dataset.i)));
    r.addEventListener('click', () => show(Number(r.dataset.i)));
  }
  wrap.addEventListener('mouseleave', () => { tip.hidden = true; for (const r of wrap.querySelectorAll('.bar-crime')) r.classList.remove('hover'); });
}

/** Crime dots on the map, sized by how many reports share each location. */
function drawCrimeMap() {
  if (!map || !crimeLayer) return;
  crimeLayer.clearLayers();
  const on = $('#crime-on-map')?.checked;
  document.querySelector('.legend .crime-key')?.toggleAttribute('hidden', !on);
  if (!on || !state.crime?.points || !state.place) return;
  const c = state.crime;
  const col = toneColour('crime');
  const accent = toneColour('accent');
  const { lat, lng } = state.place;
  for (const r of [200, 500]) {
    L.circle([lat, lng], { radius: r, color: accent, weight: 1.5, dashArray: '4 5', fill: false, interactive: false }).addTo(crimeLayer);
  }
  const spots = new Map();
  for (const p of crimePoints()) {
    const key = `${p.lat},${p.lng}`;
    const s = spots.get(key) || { lat: p.lat, lng: p.lng, street: p.street, n: 0, cats: {} };
    s.n++;
    s.cats[p.cat] = (s.cats[p.cat] || 0) + 1;
    spots.set(key, s);
  }
  for (const s of spots.values()) {
    const top = Object.entries(s.cats).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, n]) => `${esc(c.labels[k] || k)}: ${n}`).join('<br>');
    L.circleMarker([s.lat, s.lng], { radius: Math.min(3 + Math.sqrt(s.n) * 2, 16), color: col, weight: 1, fillColor: col, fillOpacity: 0.28 })
      .bindPopup(`<strong>${esc(s.street || 'Unnamed location')}</strong><br>${s.n} report${s.n === 1 ? '' : 's'} in 12 months<br><span style="opacity:.75">${top}</span>`)
      .addTo(crimeLayer);
  }
}

/* ───────────── Flood risk ───────────── */

const FLOOD_BANDS = [
  ['high', 'High', 'more than a 3.3% chance a year'],
  ['medium', 'Medium', '1% to 3.3% a year'],
  ['low', 'Low', '0.1% to 1% a year'],
  ['veryLow', 'Very low', 'less than 0.1% a year'],
];

function drawFlood() {
  const body = $('#flood-body');
  const f = state.flood;
  if (!f) return (body.innerHTML = loading('Checking Environment Agency flood data…'));
  if (f.error) return (body.innerHTML = errorBox(f.error));
  if (!f.ready) return (body.innerHTML = `<p class="note">${esc(f.message)}</p>`);
  $('#flood-sub').textContent = `Rivers and sea · Environment Agency data as at ${monthName(f.fileDate)} · an area estimate, not for a single house`;
  if (!f.covered) {
    return (body.innerHTML = '<p><span class="chip">No data</span></p><p class="note">The Environment Agency covers England only, so there are no flood figures for Wales. Natural Resources Wales publishes its own flood map.</p>');
  }
  const n = (x) => x.toLocaleString('en-GB');
  const max = Math.max(...FLOOD_BANDS.map(([k]) => f.homes[k]), 1);
  const bars = FLOOD_BANDS.map(([k, name, odds]) => `<div class="fl-row">
      <span class="fl-name"><i class="sw fl-${k === 'veryLow' ? 'vlow' : k}"></i>${name}<small>${odds}</small></span>
      <span class="fl-bar"><i style="width:${(f.homes[k] / max) * 100}%"></i></span>
      <span class="num">${n(f.homes[k])}</span>
    </div>`).join('');
  body.innerHTML = `<div class="fl-head">
      <span class="chip flood-${f.verdict}">${esc(f.label)}</span>
      <p><strong class="num">${n(f.medHigh)}</strong> home${f.medHigh === 1 ? '' : 's'} at medium or high risk within about 1 km</p>
    </div>
    <div class="fl-bars" aria-label="Homes by flood risk band">${bars}</div>
    <p class="note">${n(f.postcodesAtRisk)} of ${n(f.postcodesChecked)} nearby postcodes have homes in a flood risk area.${f.partial ? ' Welsh postcodes nearby aren\'t included.' : ''}
      Surface water (heavy rain that can't drain away) isn't in these numbers. Turn on the map to see it.</p>`;
}

function drawFloodMap() {
  if (!map || !floodLayers) return;
  const on = $('#flood-on-map')?.checked;
  $('#flood-layer').hidden = !on;
  for (const [k, l] of Object.entries(floodLayers)) {
    const want = on && k === state.floodLayer;
    if (want && !map.hasLayer(l)) l.addTo(map);
    if (!want && map.hasLayer(l)) map.removeLayer(l);
  }
  for (const li of document.querySelectorAll('.legend .flood-key')) li.toggleAttribute('hidden', !on);
  // Surface water has no "very low" band.
  if (on && state.floodLayer === 'surface') $('.legend .flood-key-vlow').hidden = true;
  $('#flood-key-name').textContent = state.floodLayer === 'surface' ? 'Surface water' : 'Rivers and sea';
  floodZoomHint();
}

function floodZoomHint() {
  const hint = $('.legend .flood-zoom');
  if (hint) hint.hidden = !$('#flood-on-map')?.checked || map.getZoom() >= FLOOD_MIN_ZOOM;
}

/* ───────────── Loading data ───────────── */

function drawAll() {
  drawGlance();
  drawTransport();
  drawSchools();
  drawPrices();
  drawCrime();
  drawFlood();
  drawMap();
  drawCrimeMap();
  drawFloodMap();
}

async function loadSection(key, url) {
  try { state[key] = await api(url); } catch (e) { state[key] = { error: e.message }; }
  drawAll();
}

function loadPrices() {
  const { lat, lng } = state.place;
  state.prices = null;
  state.showAllSales = false;
  drawPrices();
  return loadSection('prices', `/api/prices?lat=${lat}&lng=${lng}&radius=${$('#price-radius').value}&years=${$('#price-years').value}`);
}

function loadTransport() {
  const { lat, lng } = state.place;
  state.transport = null;
  drawTransport();
  return loadSection('transport', `/api/transport?lat=${lat}&lng=${lng}&dest=${$('#dest').value}`);
}

async function search(q) {
  const btn = $('#search button');
  btn.disabled = true;
  try {
    const place = await api(`/api/lookup?q=${encodeURIComponent(q)}`);
    state.place = place;
    Object.assign(state, { crimeCat: null, schools: null, transport: null, prices: null, crime: null, flood: null, showAllSchools: false, showAllSales: false });
    $('#intro').hidden = true;
    $('#results').hidden = false;
    $('#place-name').textContent = place.label;
    $('#place-area').textContent = place.area || '';
    document.title = `${place.label} · Doorstep`;
    history.replaceState(null, '', `?q=${encodeURIComponent(q)}&dest=${$('#dest').value}`);
    initMap();
    map?.invalidateSize();
    drawAll();
    const { lat, lng } = place;
    await Promise.all([
      loadSection('schools', schoolsUrl()),
      loadTransport(),
      loadPrices(),
      loadSection('crime', `/api/crime?lat=${lat}&lng=${lng}`),
      loadSection('flood', `/api/flood?lat=${lat}&lng=${lng}`),
    ]);
  } catch (e) {
    $('#intro').hidden = false;
    $('#results').hidden = true;
    let p = $('#search-error');
    if (!p) { p = document.createElement('p'); p.id = 'search-error'; p.className = 'error'; $('#intro').prepend(p); }
    p.textContent = e.message;
  } finally {
    btn.disabled = false;
  }
}

/* ───────────── Wiring ───────────── */

function segmented(id, onChange) {
  $(id).addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $(id).querySelectorAll('button')) x.setAttribute('aria-pressed', String(x === b));
    onChange(b.dataset.v);
  });
}

async function boot() {
  try {
    state.config = await api('/api/config');
  } catch {
    state.config = { destinations: [{ key: 'bank', name: 'Bank (City of London)' }] };
  }
  const params = new URLSearchParams(location.search);
  $('#dest').innerHTML = state.config.destinations.map((d) => `<option value="${d.key}">${esc(d.name)}</option>`).join('');
  if (params.get('dest')) $('#dest').value = params.get('dest');

  $('#search').addEventListener('submit', (e) => {
    e.preventDefault();
    $('#search-error')?.remove();
    search($('#q').value);
  });
  $('#dest').addEventListener('change', () => { if (state.place) { history.replaceState(null, '', `?q=${encodeURIComponent($('#q').value)}&dest=${$('#dest').value}`); loadTransport(); } });
  segmented('#school-phase', (v) => { state.schoolPhase = v; state.showAllSchools = false; drawSchools(); drawMap(); });
  $('#school-radius').addEventListener('change', () => { drawSchools(); drawMap(); });
  $('#school-sort').addEventListener('change', drawSchools);
  $('#crime-on-map').addEventListener('change', () => {
    drawCrimeMap();
    if ($('#crime-on-map').checked && map && state.place) {
      map.fitBounds(L.latLng(state.place.lat, state.place.lng).toBounds(3400));
      document.querySelector('.col-map')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    } else drawMap();
  });
  const store = { get: (k) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } } };
  $('#school-faith').value = store.get('doorstep.faith') || '';
  $('#school-hide-faith').checked = store.get('doorstep.hideFaith') === '1';
  $('#school-faith').addEventListener('change', async () => {
    store.set('doorstep.faith', $('#school-faith').value);
    if (!state.place) return;
    state.schools = await api(schoolsUrl()).catch((e) => ({ error: e.message }));
    drawSchools(); drawMap(); drawGlance();
  });
  $('#school-hide-faith').addEventListener('change', () => {
    store.set('doorstep.hideFaith', $('#school-hide-faith').checked ? '1' : '0');
    drawSchools(); drawMap();
  });
  $('#flood-on-map').addEventListener('change', () => {
    drawFloodMap();
    if ($('#flood-on-map').checked && map && state.place && map.getZoom() < FLOOD_MIN_ZOOM) {
      map.setView([state.place.lat, state.place.lng], FLOOD_MIN_ZOOM);
      document.querySelector('.col-map')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
  segmented('#flood-layer', (v) => { state.floodLayer = v; drawFloodMap(); });
  segmented('#price-type', (v) => { state.priceType = v; drawPrices(); });
  $('#price-radius').addEventListener('change', loadPrices);
  $('#price-years').addEventListener('change', loadPrices);
  $('#price-size').addEventListener('change', () => { drawPrices(); drawGlance(); });

  if (params.get('q')) {
    $('#q').value = params.get('q');
    search(params.get('q'));
  }
}

boot();
