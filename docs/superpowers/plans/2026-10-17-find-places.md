# Find places Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A "Find places" view that lists stations outside London within a set door-to-door time of a central terminus, with a likely Good+ primary and secondary nearby and a typical 4-bed price under a chosen budget.

**Architecture:** A one-off setup script (`npm run setup:stations`) builds `data/stations.json` from NaPTAN rail stations, postcodes.io (region and nearest postcode) and TfL journeys. `GET /api/find` adds the best qualifying schools per station from local data, instantly. `GET /api/find/price` fetches one station's Land Registry sales (with each sale's distance) and runs EPC only when the cheap all-sizes check can't already rule it out. The browser applies every rule with pure functions in `public/find.js`, so changing a setting re-filters without new requests.

**Tech Stack:** Node 18+ (`fetch`, `node:test`), vanilla JS modules in the browser, Leaflet 1.9.4 (already loaded). No npm packages.

**Spec:** `docs/superpowers/specs/2026-10-17-find-places-design.md`

## Global Constraints

- No npm dependencies. Plain Node 18+ and vanilla JS.
- Tests are offline: every API is mocked (`globalThis.fetch`), with tests that write data using a temp copy of `lib/` like `test/doorstep.test.mjs` does.
- Never write to `data/catchment.json` or `data/shortlist.json`.
- New cache keys are versioned (`stjourney:v1`, `findprice:v1`); bump the version if a cached shape changes.
- Never rename or remove existing `DESTINATIONS` keys (Shortlist entries store them); only add.
- UI: light and dark themes via the existing CSS tokens; pills never wrap (detail goes in a small grey line under them); plain English; tabular numbers in the body font; works at phone width.
- Walk speed is 80 m/min straight-line (`walkMinutes` in `public/snapshot.js`).
- Unknown is never a pass: a price error, fewer than 5 qualifying sales, or an EPC outage shows as "couldn't check".

## Review Focus

1. **`data/stations.json` missing** (setup never run): the Find view shows "Run `npm run setup:stations`" instead of an empty list or an error. Test in Task 3.
2. **No postcodes found around a station** (postcodes.io down): `/api/find/price` returns an error and does not cache an empty sales list. Test in Task 4.
3. **EPC service failing while `EPC_TOKEN` is set:** the station is "couldn't check", never a pass, and the failure isn't cached. Tests in Tasks 1 and 4.
4. **Budget raised past a station that was ruled out by the cheap check:** that station is fetched again with EPC rather than staying "over budget". Test in Task 1 (`needs-epc`).
5. **A station TfL can't plan a journey for:** recorded with `trainMin: null`, counted in the setup summary, never shown as passing. Test in Task 2.

---

### Task 1: Pure rules in `public/find.js`

**Files:**
- Create: `public/find.js`
- Test: `test/find.test.mjs`

**Interfaces:**
- Produces:
  - `MIN_WALK = 5`, `WALK_M_PER_MIN = 80`, `MIN_SALES = 5`, `MIN_ROOMS = 5`
  - `walkAllowance(trainMin: number|null, { maxDoor = 60, maxWalk = 15 }) -> number|null`: minutes `min(maxWalk, maxDoor - trainMin)`; `null` when `trainMin` is null or the result is under `MIN_WALK`.
  - `schoolsPass(station) -> boolean`: `Boolean(station.primary && station.secondary)`.
  - `priceVerdict(p, { allowanceMin, budget }) -> { status: 'pass'|'over'|'unknown'|'needs-epc', median: number|null, count: number, reason: string, allSizes: boolean }`, where `p` is the `/api/find/price` body (Task 4): `{ error?, allSizesMedian, sales: [{ price, distance, rooms }], epc: { enabled, ran, error } }`.
  - `rankStations(stations, settings) -> Array<station & { allowanceMin }>`: stations with a non-null allowance and `schoolsPass`, sorted by `trainMin` ascending then name.

- [ ] **Step 1: Write the failing tests** in `test/find.test.mjs`:

```js
import { walkAllowance, priceVerdict, rankStations } from '../public/find.js';

test('walk allowance shrinks with the train and drops under 5 minutes', () => {
  assert.equal(walkAllowance(40, { maxDoor: 60, maxWalk: 15 }), 15);
  assert.equal(walkAllowance(50, { maxDoor: 60, maxWalk: 15 }), 10);
  assert.equal(walkAllowance(55, { maxDoor: 60, maxWalk: 15 }), 5);
  assert.equal(walkAllowance(56, { maxDoor: 60, maxWalk: 15 }), null);
  assert.equal(walkAllowance(null, {}), null);
});

const sale = (price, distance, rooms = 6) => ({ price, distance, rooms, type: 'Detached' });
const five = (price, distance = 300) => Array.from({ length: 5 }, () => sale(price, distance));

test('price: 4-bed median within the walk allowance against the budget', () => {
  const p = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: null },
    sales: [...five(700000), sale(2000000, 1100), sale(300000, 300, 3)] };
  const v = priceVerdict(p, { allowanceMin: 10, budget: 800000 }); // 800 m: drops the 1,100 m sale; 3 rooms dropped
  assert.equal(v.status, 'pass'); assert.equal(v.median, 700000); assert.equal(v.count, 5);
  assert.equal(priceVerdict(p, { allowanceMin: 10, budget: 650000 }).status, 'over');
});

test('price: unknown is never a pass', () => {
  const thin = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: null }, sales: five(500000).slice(0, 4) };
  assert.equal(priceVerdict(thin, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
  const outage = { allSizesMedian: 500000, epc: { enabled: true, ran: true, error: 'EPC down' }, sales: five(500000) };
  assert.equal(priceVerdict(outage, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
  assert.equal(priceVerdict({ error: 'postcodes.io down' }, { allowanceMin: 15, budget: 900000 }).status, 'unknown');
});

test('price: cheap check rules out, or asks for EPC when the budget is raised', () => {
  const skipped = { allSizesMedian: 900000, epc: { enabled: true, ran: false, error: null }, sales: five(900000) };
  assert.equal(priceVerdict(skipped, { allowanceMin: 15, budget: 800000 }).status, 'over');
  assert.equal(priceVerdict(skipped, { allowanceMin: 15, budget: 950000 }).status, 'needs-epc');
});

test('price: without an EPC token, all detached and semi sales count and say so', () => {
  const p = { allSizesMedian: 600000, epc: { enabled: false, ran: false, error: null }, sales: five(600000).map((s) => ({ ...s, rooms: null })) };
  const v = priceVerdict(p, { allowanceMin: 15, budget: 700000 });
  assert.equal(v.status, 'pass'); assert.equal(v.allSizes, true);
});

test('ranking: commute and schools filter, fastest train first', () => {
  const st = (name, trainMin, ok = true) => ({ name, trainMin, primary: ok ? {} : null, secondary: {} });
  const out = rankStations([st('B', 50), st('A', 30), st('C', 58), st('D', 20, false), st('E', null)], { maxDoor: 60, maxWalk: 15 });
  assert.deepEqual(out.map((s) => s.name), ['A', 'B']);
  assert.equal(out[1].allowanceMin, 10);
});
```

(Use the file's standard `node:test` / `node:assert/strict` imports.)

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/find.test.mjs`
Expected: FAIL, cannot find module `public/find.js`.

- [ ] **Step 3: Implement `public/find.js`** with the exports above. `priceVerdict` order:
  1. `p.error` → unknown, reason = the error.
  2. `!epc.enabled` → use all sales within `allowanceMin * 80` m, `allSizes: true`.
  3. `!epc.ran` → `allSizesMedian > budget` ? over ("Every house nearby is over budget") : `needs-epc`.
  4. `epc.error` → unknown ("The energy certificate service isn't responding").
  5. Otherwise use sales with `rooms >= 5` within the allowance.

  Under `MIN_SALES` → unknown ("Not enough sales"). Use `median` from `./snapshot.js`. The `over` reason says how far over, e.g. `over budget by £60k`.

- [ ] **Step 4: Run to see them pass**

Run: `node --test test/find.test.mjs`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add public/find.js test/find.test.mjs
git commit -m "feat(find): pure rules for walk allowance, price verdict and ranking"
```

---

### Task 2: Station setup (`npm run setup:stations`)

**Files:**
- Modify: `lib/sources.mjs` (the `DESTINATIONS` block near line 74; export `journey` and `nextTuesday`)
- Create: `lib/stations.mjs`, `scripts/build-stations.mjs`
- Modify: `package.json` (add `"setup:stations": "node scripts/build-stations.mjs"`; leave `setup` as is, since this run is long)
- Test: `test/find.test.mjs`

**Interfaces:**
- Consumes: `fetchJson`, `cached`, `mapLimit`, `distanceM`, `parseCsv`, `DATA_DIR` from `lib/util.mjs`; `journey(from, to, date)` and `nextTuesday()` from `lib/sources.mjs` (export both; `journey` returns the summarised best journey `{ minutes, changes, changeAt, legs }` or null).
- Produces:
  - `TERMINI: string[]` in `lib/sources.mjs`: the 16 terminus keys. Add these keys to `DESTINATIONS`, keeping the existing seven: `stpancras` St Pancras (51.5308, -0.1260), `euston` Euston (51.5282, -0.1337), `paddington` Paddington (51.5154, -0.1755), `fenchurch` Fenchurch Street (51.5115, -0.0789), `victoria` Victoria (51.4952, -0.1441), `marylebone` Marylebone (51.5225, -0.1631), `cannon` Cannon Street (51.5113, -0.0904), `charingx` Charing Cross (51.5080, -0.1247), `blackfriars` Blackfriars (51.5116, -0.1033), `moorgate` Moorgate (51.5186, -0.0886), `citytl` City Thameslink (51.5139, -0.1036), `farringdon` Farringdon (51.5203, -0.1053). Then `TERMINI = ['waterloo','londonbridge','kingsx','stpancras','euston','paddington','liverpool','fenchurch','victoria','marylebone','cannon','charingx','blackfriars','moorgate','citytl','farringdon']`.
  - `parseNaptanRail(csvText) -> [{ id, name, lat, lng }]`: rows with `StopType === 'RLY'` and `Status === 'active'`; `id` = `ATCOCode`; `name` = `CommonName` without a trailing ` Rail Station`.
  - `buildStations({ log = console.log } = {}) -> Promise<{ builtAt, journeyDate, source, stations, failed }>`, where each station is `{ id, name, lat, lng, postcode, terminus, trainMin, changes, changeAt }` and `trainMin`/`terminus` are null when no journey was found.
  - `MAX_TRAIN_MIN = 85` (largest door-to-door setting 90 minus `MIN_WALK`), `PREFILTER_KM = 100`.

**Pipeline inside `buildStations`:**
1. Download `https://naptan.api.dft.gov.uk/v1/access-nodes?dataFormat=csv&atcoAreaCodes=910` (checked on 17 Oct 2026: 2,716 RLY rows with `Latitude`/`Longitude`). Keep stations within `PREFILTER_KM` of Charing Cross.
2. Look up region and nearest postcode with postcodes.io bulk reverse: `POST https://api.postcodes.io/postcodes` with body `{ geolocations: [{ latitude, longitude, limit: 1, radius: 1000 }] }`, 100 per request. The response is `result[i].result[0].{ postcode, region, country }`. Drop stations whose `region === 'London'` or whose `country !== 'England'`. If no postcode is found within 1 km, retry with `radius: 2000`; still none → drop and count it.
3. For each station, try the 3 termini nearest by straight-line distance via `journey(station, DESTINATIONS[key], date)`, each wrapped in `cached('stjourney:v1:<id>:<key>:<date>', 24 * 30, …)`, which makes a re-run resume for free. Keep the fastest. Concurrency 4. Log progress every 25 stations: `Planned 125 of 512 stations…`.
4. Keep stations with `trainMin <= MAX_TRAIN_MIN`. Keep null-journey stations out of `stations` but count them in `failed`.

The script `scripts/build-stations.mjs` calls `loadEnv()`, then `buildStations()`, writes `data/stations.json` atomically (`.tmp` then rename, as in `build-flood.mjs`) and prints `Saved N stations (M couldn't be planned) to data/stations.json`.

- [ ] **Step 1: Write the failing tests**, using a temp copy of `lib/` (same pattern as `API flows with mocked services` in `test/doorstep.test.mjs`) and a mocked `fetch` that serves:
  - a NaPTAN CSV with 4 RLY stations: `Harpenden` (51.8146, -0.3515), `Clapham Junction` (51.4642, -0.1703), `Norwich` (52.6273, 1.3069, beyond 100 km), and `Nowhere` (51.9, -0.2) plus one `inactive` row;
  - postcodes.io bulk reverse: Harpenden → region "East of England", Clapham → region "London", Nowhere → "East of England";
  - TfL Journey: Harpenden to any terminus → `duration: 27` (and record calls); Nowhere → `{ journeys: [] }`.

```js
test('station setup: outside London only, fastest terminus, resume uses the cache', async () => {
  const { buildStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  const out = await buildStations({ log: () => {} });
  assert.deepEqual(out.stations.map((s) => s.name), ['Harpenden']);
  assert.equal(out.stations[0].trainMin, 27);
  assert.ok(TERMINI.includes(out.stations[0].terminus));
  assert.equal(out.failed, 1);              // Nowhere: no journey
  assert.equal(tflCalls, 6);                // 3 termini each for Harpenden and Nowhere
  tflCalls = 0;
  await buildStations({ log: () => {} });
  assert.equal(tflCalls, 3);                // Harpenden cached; Nowhere's empty result retried
});
```

Wrap the cached journey so a null result throws inside `cached` and isn't stored; that's why Nowhere is retried.

- [ ] **Step 2: Run to see it fail**

Run: `node --test test/find.test.mjs`
Expected: FAIL, `lib/stations.mjs` not found.

- [ ] **Step 3: Implement** the `DESTINATIONS`/`TERMINI` additions, `lib/stations.mjs`, `scripts/build-stations.mjs` and the `package.json` script.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: all PASS, including existing destination tests.

- [ ] **Step 5: Commit**

```bash
git add lib/sources.mjs lib/stations.mjs scripts/build-stations.mjs package.json test/find.test.mjs
git commit -m "feat(find): setup:stations builds stations.json from NaPTAN, postcodes.io and TfL"
```

---

### Task 3: `GET /api/find` (stations plus best qualifying schools)

**Files:**
- Modify: `lib/stations.mjs`, `server.mjs` (the `routes` object)
- Test: `test/find.test.mjs`

**Interfaces:**
- Consumes: `nearbySchools(lat, lng, radiusM, faith)` from `lib/sources.mjs`; `goodChance` from `public/snapshot.js`.
- Produces: `findStations(faith: string|null) -> { ready: false, message } | { ready: true, builtAt, journeyDate, schoolsAsOf, stations: [station & { primary, secondary }] }`, where `primary`/`secondary` = `{ urn, name, headline, tone, distance, label } | null`. Each is the best school of that phase within 3,000 m of the station that has `rating.tone` of `'great'` or `'good'` **and** `goodChance(s)`. Best = `'great'` before `'good'`, then nearest. Phase is `s.phase === 'Primary'` / `'Secondary'`.
- Route: `'/api/find': async (p) => findStations(p.get('faith') || null)`.
- Missing file message, exact copy: `Station data isn't built yet. Run "npm run setup:stations" in the project folder (it takes 20 to 40 minutes), then restart.`
- Read `stations.json` once per server start, like `loadFlood`. Add a comment that a rebuilt file needs a restart.

- [ ] **Step 1: Write the failing tests** (temp project with `schools.json` and `stations.json`):

```js
test('find: best likely Good+ school per phase from the station, faith respected', async () => {
  // schools.json: near primary tone 'good'; nearer primary tone 'mixed'; secondary tone 'great' Catholic 300 m.
  const { findStations } = await import(path.join(tmp, 'lib', 'stations.mjs'));
  let r = findStations(null);
  assert.equal(r.stations[0].primary.name, 'Good Primary');
  assert.equal(r.stations[0].secondary.name, 'St Mary RC');
  r = findStations('none'); // a strict faith the family doesn't share -> unlikely -> no secondary
  assert.equal(r.stations[0].secondary, null);
});

test('find: missing stations.json asks for setup', async () => {
  // separate temp dir without stations.json
  assert.equal(findStations(null).ready, false);
  assert.match(findStations(null).message, /npm run setup:stations/);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/find.test.mjs`
Expected: FAIL, `findStations` is not exported.

- [ ] **Step 3: Implement `findStations` and the route.**

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/stations.mjs server.mjs test/find.test.mjs
git commit -m "feat(find): /api/find lists stations with their best likely Good+ schools"
```

---

### Task 4: `GET /api/find/price` (one station's sales, EPC only when needed)

**Files:**
- Modify: `lib/sources.mjs` (export `landRegistrySales`), `lib/epc.mjs` (`enrichWithEpc`), `lib/stations.mjs`, `server.mjs`
- Test: `test/find.test.mjs`, `test/doorstep.test.mjs` (existing EPC expectations still hold)

**Interfaces:**
- Consumes: `postcodesAround(lat, lng, 1200)`, `landRegistrySales(postcodes, sinceIso)`, `enrichWithEpc(sales)`, `median`.
- Changes `enrichWithEpc(sales)` to also return `postcodes` (how many searched) and `searchFailed` (EPC searches that threw). Today `certificatesForPostcode(...).catch(() => [])` hides those, so count them in the catch.
- Produces: `stationPrice(id: string, budget: number) -> { id, since, allSizesMedian, sales: [{ price, date, type, distance, rooms }], epc: { enabled, ran, error } }`.
  - Sales: standard (category A) detached/semi from the last 3 years within 1,200 m of the station. `distance` = that postcode's distance from `postcodesAround`. Cached as `findprice:v1:<id>:<since>`, 7 days. **Throw** (no cache) when no postcodes are found: `Couldn't look up postcodes near this station. Try again in a minute.`
  - `allSizesMedian` = median of those sales' prices.
  - EPC runs only when `EPC_TOKEN` is set **and** `budget >= allSizesMedian`. Then `ran: true`, and `rooms` = `habitableRooms`. `epc.error` = `"The energy certificate service isn't responding"` when `searchFailed > 0.2 * postcodes` or `failed > 0.2 * matched-to-fetch`. EPC results are cached per certificate already, and failures aren't (they throw inside `cached`).
  - Unknown station id → 404 `Unknown station.`.
- Route: `'/api/find/price': async (p) => stationPrice(String(p.get('id') || ''), Number(p.get('budget')) || 0)`.

- [ ] **Step 1: Write the failing tests** (mocked postcodes.io, Land Registry, EPC):

```js
test('station price: distances attached, EPC skipped when everything is over budget', async () => {
  const r = await stationPrice('9100HRPNDN', 300000); // all mocked sales ~£600k+
  assert.equal(r.epc.ran, false); assert.equal(epcCalls, 0);
  assert.ok(r.sales.every((s) => Number.isFinite(s.distance)));
});

test('station price: EPC runs when the budget could pass, and an outage is flagged not cached', async () => {
  epcDown = true;
  const r = await stationPrice('9100HRPNDN', 900000);
  assert.equal(r.epc.ran, true); assert.match(r.epc.error, /isn't responding/);
  epcDown = false;
  const again = await stationPrice('9100HRPNDN', 900000);
  assert.equal(again.epc.error, null); assert.ok(again.sales.some((s) => s.rooms >= 5));
});

test('station price: no postcodes is an error and is not cached', async () => {
  postcodesDown = true;
  await assert.rejects(stationPrice('9100HRPNDN', 900000), /Couldn't look up postcodes/);
  postcodesDown = false;
  assert.ok((await stationPrice('9100HRPNDN', 900000)).sales.length);
});
```

- [ ] **Step 2: Run to see them fail**

Run: `node --test test/find.test.mjs`
Expected: FAIL, `stationPrice` is not exported.

- [ ] **Step 3: Implement** the `enrichWithEpc` counts, the `landRegistrySales` export, `stationPrice` and the route.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS (the existing `prices()` path is unchanged apart from the two new fields in `epc`).

- [ ] **Step 5: Commit**

```bash
git add lib/sources.mjs lib/epc.mjs lib/stations.mjs server.mjs test/find.test.mjs
git commit -m "feat(find): /api/find/price with cheap budget check and EPC outage handling"
```

---

### Task 5: The Find places page

**Files:**
- Modify: `public/index.html` (top-bar link next to `#shortlist-link`; new `<section id="find" class="find" hidden>` after `#shortlist`)
- Create: `public/find-view.js` (all Find view DOM code, imported by `app.js`, to keep `app.js` from growing)
- Modify: `public/app.js` (`showView`, `search`, `boot`: route `?view=find`, hide `#find` when searching, and wire the link)
- Modify: `public/styles.css`

**Interfaces:**
- Consumes: `walkAllowance`, `priceVerdict`, `rankStations` (Task 1); `/api/find?faith=` (Task 3); `/api/find/price?id=&budget=` (Task 4); `api()`, `esc`, `gbpShort` and `dist` from `app.js`. Pass them in via `initFind({ api, esc, gbpShort, dist, openPlace })` rather than importing from `app.js`.
- Produces: `initFind(deps)` and `showFind()` exported from `public/find-view.js`. `openPlace(postcode, destKey)` in `app.js` sets `#dest` to `destKey`, sets `#q` and calls `search(postcode)`; that already pushes history when leaving a `view=` page.

**Behaviour:**
- **Settings bar**, each a `<select>` saved in localStorage via the same try/catch `store` pattern as `boot()`:
  - Door to door: 45/50/55/60/65/70/75/80/90 min, default 60 (`doorstep.find.maxDoor`).
  - Max walk: 5/10/15/20 min, default 15 (`doorstep.find.maxWalk`).
  - Budget: £400k–£1.5m in £50k steps, default £800k (`doorstep.find.budget`).
  - Faith: the same options as `#school-faith`, read from and written to `doorstep.faith`. Changing it refetches `/api/find` and keeps price results.
  - A fixed line: "Schools: a Good or Outstanding primary and secondary you'd likely get into".
- **On show:** fetch `/api/find`. If `ready: false`, show the message in the list area. Otherwise `rankStations`, then queue price checks for the ranked stations in order (concurrency 3). `state.prices` holds `Map<id, body>`; a station is re-requested only if it has no result or its verdict is `needs-epc` at the current budget. Any setting change re-runs `rankStations` and `priceVerdict` and redraws, without refetching anything already held.
- **List** (left) shows stations whose verdict is `pass`, numbered in rank order, then rows still `checking price…`. A collapsed `<details>` "Couldn't check the price (N)" lists `unknown` rows with the reason. "Over budget" rows aren't shown. Progress line: `Checking prices: 12 of 40`. When most results are EPC errors, show one banner (the spec's wording) instead of per-row reasons.
- **Each passing row** shows:
  - **name** and `27 min to St Pancras · direct` (or `· 1 change at X`)
  - `walk up to 10 min`
  - primary and secondary: name, tone pill (`chipHtml`-style, never wraps), distance from the station
  - `£760k typical 4-bed` with a small grey `from 14 sales` line
  - `all house sizes` if `allSizes`.
- **Map** (right, own Leaflet map in `#find-map`): numbered `L.divIcon` markers for passing rows. Hovering a row toggles a highlight class on its marker and vice versa. Fit bounds to the markers.
- **Click a row** (whole row, keyboard-focusable `<button>` or `tabindex=0` + Enter) → `openPlace(station.postcode, station.terminus)`.
- **Data line:** `Train times as at <builtAt> (journeys planned for <journeyDate>, arriving 09:00) · Ofsted results as at <schoolsAsOf> · Sales from the last 3 years`.
- Phone width: list above map, map 300px tall.

- [ ] **Step 1: Build the markup, view routing and settings bar.** `?view=find` shows `#find` and hides `#intro`, `#results` and `#shortlist`, and the top link gets `aria-current="page"`. Searching from the top bar hides `#find`.
- [ ] **Step 2: Build the list, price queue and map** as above.
- [ ] **Step 3: Run tests**

Run: `npm test`
Expected: PASS (no front-end tests; this guards the shared modules).

- [ ] **Step 4: Check it in the real app with mocked data.** Write a throwaway `data/stations.json` with 3 real stations (Harpenden, Shenfield, Haslemere), start `npm start`, and open `http://localhost:5173/?view=find` in Chrome.
  - Check: the list fills in, changing the budget re-filters instantly (watch the server log: no new `/api/find/price` lines for already-fetched stations), the map pins match the numbers, and clicking a row opens the place with the commute dropdown set to that terminus.
  - Check light and dark themes and a 390px-wide window.
  - Delete the throwaway file afterwards.
- [ ] **Step 5: Commit**

```bash
git add public/index.html public/find-view.js public/app.js public/styles.css
git commit -m "feat(find): Find places view with ranked list, live prices and map"
```

---

### Task 6: Real run, docs

**Files:**
- Modify: `CLAUDE.md` (Run section: `npm run setup:stations`; layout table: `lib/stations.mjs`, `public/find.js`, `public/find-view.js`, `scripts/build-stations.mjs`; data sources: NaPTAN; a "How the tricky parts work → Find places" subsection summarising the rules and the cheap check; cache keys list `stjourney:v1`, `findprice:v1`)
- Modify: `ROADMAP.md` (move item 2 to "Already done"; set the next suggestion)
- Modify: `README.md` if it lists setup commands

- [ ] **Step 1: Run the real setup in the background**

Run: `npm run setup:stations`
Expected: progress lines, ending in `Saved N stations (M couldn't be planned)`. N should be a few hundred and M a small fraction. Spot-check Harpenden (~25–30 min to St Pancras) and Shenfield (~25–35 min to Liverpool Street) in `data/stations.json`.

- [ ] **Step 2: Real search.** Restart `npm start`, open `?view=find` with the defaults (60/15/£800k) and confirm results appear and prices fill in. Note the time to the first priced row.
- [ ] **Step 3: Update the docs** listed above.
- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md ROADMAP.md README.md
git commit -m "docs: Find places in CLAUDE.md and roadmap"
```
