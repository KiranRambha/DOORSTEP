# Shortlist and Flood Risk Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a flood-risk panel and map layers, then a saved shortlist that compares places side by side.

**Architecture:** Flood: a setup script turns the Environment Agency's postcode zip into `data/flood.json`, and `/api/flood` sums the postcodes within 1 km. Shortlist: a new pure browser module `public/snapshot.js` turns the page's loaded data into a snapshot (it's also imported by the Node tests). The server just stores entries in `data/shortlist.json`.

**Tech Stack:** Node 18+ (no npm deps), `node:test`, vanilla JS front end, Leaflet 1.9.4 (`L.tileLayer.wms`).

**Spec:** `docs/superpowers/specs/2026-10-16-shortlist-and-flood-design.md`. Read it first; it holds the data URLs, CSV columns, band meanings and column rules.

## Global Constraints

- No npm dependencies. Plain Node `fetch`, `zlib`, `node:test`.
- `data/shortlist.json` and `data/catchment.json` must never be deleted or overwritten with a blank list.
- Pills/chips never wrap: verdict word in the pill, detail in a small grey line under it (`chipHtml` / `splitLabel` pattern).
- Every panel says how current its data is.
- Light and dark themes via CSS tokens in `:root` and the dark media query. Check both.
- Plain English in the UI. No browser `alert`/`confirm`/`prompt`.
- Cache keys are versioned. New key: `flood:v1`.
- Distances and prices use the body font with tabular numbers.
- `npm test` must stay fully offline (mock `fetch`).

## Review Focus

1. **A place in Wales** → flood panel, glance item and shortlist column say "No flood data for Wales", never "Low risk area". (Test in Task 3.)
2. **`data/shortlist.json` exists but can't be parsed** → the API returns an error and the file is left untouched. It must not be silently replaced by a list with one entry. (Test in Task 5.)
3. **The same place saved twice with different spelling** (`sg51nz`, `SG5 1NZ`) → one entry, updated in place. (Test in Task 5.)
4. **Save while a section is still loading or has failed** → that section is `null` and shows "–". Nothing throws. (Test in Task 6.)
5. **`data/flood.json` missing** → `/api/flood` returns `{ ready: false, message }`. The panel shows the setup hint and the shortlist column shows "–". (Test in Task 3.)

---

### Task 1: Zip reader

**Files:**
- Create: `lib/unzip.mjs`
- Test: `test/doorstep.test.mjs` (add a `makeZip` helper and tests)

**Interfaces:**
- Produces: `readZipEntry(buf: Buffer, match: RegExp) -> { name: string, data: Buffer, modified: string /* 'YYYY-MM-DD' */ } | null`

- [ ] **Step 1: Add test helper `makeZip(entries: [{ name, text, method: 0|8, date: Date }]) -> Buffer`** to the test file. It writes local headers, a central directory and the end-of-central-directory record. Use `zlib.deflateRawSync` for method 8 and `zlib.crc32` if present (Node ≥ 20.15), otherwise a small CRC table. Put real sizes in the central directory and **zeros** in the local headers with general-purpose flag bit 3 set, the same way the EA file does it with data descriptors.

- [ ] **Step 2: Write failing tests**

```js
test('zip reader finds a deflated entry by pattern, using the central directory', () => {
  const zip = makeZip([
    { name: 'X/DATA/', text: '', method: 0, date: new Date(2026, 5, 12) },
    { name: 'X/DATA/NaFRA2client.RoFRS_Postcodes_AtRisk.csv', text: 'PC,cntpc\nAB1 2CD,5\n', method: 8, date: new Date(2026, 5, 12) },
  ]);
  const e = readZipEntry(zip, /AtRisk\.csv$/);
  assert.equal(e.data.toString('utf8'), 'PC,cntpc\nAB1 2CD,5\n');
  assert.equal(e.modified, '2026-06-12');
  assert.equal(readZipEntry(zip, /nope/), null);
});
test('zip reader rejects something that is not a zip', () => {
  assert.throws(() => readZipEntry(Buffer.from('<html>error page</html>'), /csv/), /not a zip/i);
});
```

- [ ] **Step 3: Run** `npm test`. Expected: FAIL, `readZipEntry` is not defined.

- [ ] **Step 4: Implement `readZipEntry` in `lib/unzip.mjs`.** Find the end-of-central-directory signature `0x06054b50` by scanning back from the end. Walk the central directory entries (`0x02014b50`), take the compressed size and local-header offset from there, skip the local header's name and extra fields, and inflate with `zlib.inflateRawSync` (method 8) or copy (method 0). Decode the DOS date. Throw `Error('Not a zip file')` when there's no end record. Methods other than 0 and 8 throw too.

- [ ] **Step 5: Run** `npm test`. Expected: PASS.

- [ ] **Step 6: Commit** `feat: small dependency-free zip reader`

---

### Task 2: Flood data setup

**Files:**
- Create: `lib/flood.mjs`, `scripts/build-flood.mjs`
- Modify: `package.json` (scripts), `.gitignore` (add `.superpowers/`)
- Test: `test/doorstep.test.mjs`

**Interfaces:**
- Consumes: `readZipEntry` (Task 1), `parseCsv`, `normalisePostcode` from `lib/util.mjs`.
- Produces: `parseFloodCsv(text: string) -> { [postcode]: [res, high, medium, low, veryLow] }` in `lib/flood.mjs`; `data/flood.json` = `{ source: string, fileDate: 'YYYY-MM-DD', builtAt: ISO string, postcodes: {...} }`.

- [ ] **Step 1: Write failing test**

```js
test('flood CSV parses residential counts per postcode and strips the BOM', () => {
  const csv = '﻿PC,cntpc,RES_cntpc,NRP_cntpc,UNC_cntpc,RES_CNT_VeryLow,NRP_CNT_VeryLow,UNC_CNT_VeryLow,TOT_CNT_VeryLow,RES_CNT_Low,NRP_CNT_Low,UNC_CNT_Low,TOT_CNT_Low,RES_CNT_Medium,NRP_CNT_Medium,UNC_CNT_Medium,TOT_CNT_Medium,RES_CNT_High,NRP_CNT_High,UNC_CNT_High,TOT_CNT_High,SORTOFF,DISTRICT,SECTOR,UNIT\r\n'
    + 'WF13 2HF,15,4,7,4,0,0,0,0,4,7,2,13,0,0,1,1,0,0,1,1,WF,13,2,HF\r\n'
    + 'tn91rd,30,20,5,5,1,0,0,1,2,0,0,2,3,0,0,3,4,0,0,4,TN,9,1,RD\r\n';
  assert.deepEqual(parseFloodCsv(csv), { 'WF13 2HF': [4, 0, 0, 4, 0], 'TN9 1RD': [20, 4, 3, 2, 1] });
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `parseFloodCsv`.** Find columns by header name, never by position. Order is `[RES_cntpc, RES_CNT_High, RES_CNT_Medium, RES_CNT_Low, RES_CNT_VeryLow]`. Normalise postcodes. Skip rows whose postcode doesn't normalise.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Write `scripts/build-flood.mjs`**, modelled on `scripts/build-schools.mjs`. It downloads the zip URL from the spec with `fetch` as an `arrayBuffer`, uses `readZipEntry(buf, /AtRisk\.csv$/i)`, writes `data/flood.json` with `source` (the dataset title plus URL) and `fileDate` (the entry's `modified`), then prints the postcode count. Write to `flood.json.tmp`, then rename, so a failed run never leaves a half-written file.

- [ ] **Step 6: Update `package.json`**: `"setup": "node scripts/build-schools.mjs && node scripts/build-flood.mjs"`, `"setup:flood": "node scripts/build-flood.mjs"`. Add `.superpowers/` to `.gitignore`.

- [ ] **Step 7: Run for real** with `npm run setup:flood`. Expected: about 270,000 postcodes and `fileDate` 2026-06-12. Spot-check with `node -e "const f=require('./data/flood.json');console.log(f.fileDate,Object.keys(f.postcodes).length,f.postcodes['WF13 2HF'])"` → `2026-06-12 ~270000 [ 4, 0, 0, 4, 0 ]`.

- [ ] **Step 8: Commit** `feat: download Environment Agency flood postcodes in setup`

---

### Task 3: Flood summary API

**Files:**
- Modify: `lib/sources.mjs` (`postcodesAround`, `prices` call site), `lib/flood.mjs`, `server.mjs`
- Test: `test/doorstep.test.mjs`

**Interfaces:**
- Consumes: `parseFloodCsv` output shape (Task 2).
- Produces:
  - `postcodesAround(lat, lng, radiusM, { dense = false } = {}) -> Promise<[{ postcode, country }]>`, now exported. `prices()` maps to `.postcode`, so its behaviour and cache are unchanged. `dense` uses rings `[[300, 4], [600, 8], [900, 12]]` for radius ≤ 1100.
  - `FLOOD_THRESHOLDS = { higherHomes: 50, higherShare: 0.10 }`
  - `floodSummary(pcs: [{postcode, country}], data: {postcodes}) -> { covered: boolean, partial: boolean, postcodesChecked, postcodesAtRisk, homes: { high, medium, low, veryLow }, homesInAtRiskPostcodes, medHigh, verdict: 'low'|'some'|'higher'|null, label: string }`
  - `async flood(lat, lng) -> { ready: false, message } | { ready: true, source, fileDate, ...floodSummary }` (cached under `flood:v1:${lat.toFixed(4)},${lng.toFixed(4)}`; cache only the postcode list so a newer `flood.json` takes effect straight away)
  - `GET /api/flood?lat&lng`

- [ ] **Step 1: Write failing tests**

```js
test('flood summary counts English postcodes and picks a verdict', () => {
  const data = { postcodes: { 'TN9 1RD': [20, 4, 3, 2, 1], 'TN9 1RE': [10, 0, 0, 5, 0] } };
  const pcs = [{ postcode: 'TN9 1RD', country: 'England' }, { postcode: 'TN9 1RE', country: 'England' }, { postcode: 'TN9 1RF', country: 'England' }];
  const s = floodSummary(pcs, data);
  assert.deepEqual(s.homes, { high: 4, medium: 3, low: 7, veryLow: 1 });
  assert.equal(s.medHigh, 7);
  assert.equal(s.postcodesChecked, 3);
  assert.equal(s.postcodesAtRisk, 2);
  assert.equal(s.verdict, 'higher');            // 1 of 3 postcodes (33%) has medium/high homes, which is at least 10%
  assert.equal(floodSummary([{ postcode: 'TN9 1RF', country: 'England' }], data).verdict, 'low');
});
test('flood summary: Wales is not covered, border areas are partial', () => {
  const data = { postcodes: {} };
  const wales = floodSummary([{ postcode: 'CF10 1AA', country: 'Wales' }], data);
  assert.equal(wales.covered, false);
  assert.equal(wales.verdict, null);
  assert.equal(wales.label, 'No flood data for Wales');
  const border = floodSummary([{ postcode: 'CF10 1AA', country: 'Wales' }, { postcode: 'HR1 1AA', country: 'England' }], data);
  assert.equal(border.covered, true);
  assert.equal(border.partial, true);
  assert.equal(border.postcodesChecked, 1);
});
```

Extend the existing `'API flows with mocked services'` test. Add `country` to the mocked `postcodes?lat=` results. Assert that `flood()` returns `{ ready: false }` before `data/flood.json` exists, then write a small `flood.json` into the temp dir and assert `ready: true` with the expected `medHigh`. Also assert that `prices()` output is unchanged.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement.** Verdict: `medHigh === 0` → `'low'` "Low risk area". `medHigh >= 50` or the share of checked postcodes with medium/high homes `>= 0.10` → `'higher'` "Higher risk". Otherwise `'some'` "Some risk". Load `flood.json` lazily and keep it in memory, like `loadSchools()`. Add the route to `server.mjs` using the `point()` validation.

- [ ] **Step 4: Run** `npm test`. Expected: PASS, including the existing price assertions.

- [ ] **Step 5: Commit** `feat: /api/flood area summary from EA postcode data`

---

### Task 4: Flood panel and map layers

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: `/api/flood` response (Task 3).
- Produces: `state.flood` (the API response or `{ error }`), loaded in `search()` alongside the others with `loadSection('flood', …)`. Task 6 reads it.

- [ ] **Step 1: Panel `#p-flood` after `#p-crime`.** In the header: "Flood risk", the tickbox `#flood-on-map` "Show flood risk on map", and `#flood-sub` = "Rivers and sea · Environment Agency data as at Jun 2026 · an area estimate, not for a single house" (month from `fileDate`). The body has a verdict pill (`.chip` with new classes `flood-low|flood-some|flood-higher`), "N homes at medium or high risk within about 1 km", a four-row band breakdown (high / medium / low / very low, with the plain-English chances from the spec), "N of M nearby postcodes have homes at risk", and a note: "Surface water (heavy rain) isn't in these numbers. Turn on the map layer to see it." States: loading, error, `ready:false` (setup hint), `covered:false` ("No flood data for Wales"), and `partial` (add "Welsh postcodes nearby aren't included").

- [ ] **Step 2: Map layers.** In `initMap()`, create (but don't add) `L.tileLayer.wms` for both URLs from the spec: layers `rofrs_4band` and `rofsw`, `format: 'image/png'`, `transparent: true`, `opacity: 0.6`. The tickbox adds or removes both. Add two legend `<li class="flood-key" hidden>` items: "Flood risk: rivers and sea" and "Flood risk: surface water". Fetch each layer's `GetLegendGraphic` once in the browser to choose swatch colours that match the tiles. If the two layers' colours are too close to tell apart, give surface water a lower opacity and note it in the legend.

- [ ] **Step 3: Glance item** "Flood risk": the verdict word, plus small text "N homes at medium/high risk nearby". Wales shows "–" with small text "no data for Wales".

- [ ] **Step 4: Footer** gets "Contains Environment Agency data licensed under the Open Government Licence v3.0." Add "Flood risk: Environment Agency" to the intro sources list.

- [ ] **Step 5: Verify in the browser.** Restart with `npm start`, look up `TN9 1RD` (Tonbridge, near the Medway) and `SG5 1NZ`. Expected: the panel renders, the tickbox shows both layers along the river, and the legend appears and disappears with the tickbox. Check light and dark themes and a 390 px wide window (no pill wraps, no sideways page scroll). Then look up `CF10 1AA` (Cardiff). Expected: "No flood data for Wales" in the panel and glance.

- [ ] **Step 6: Commit** `feat: flood risk panel, glance item and map layers`

---

### Task 5: Shortlist storage and API

**Files:**
- Create: `lib/shortlist.mjs`
- Modify: `server.mjs`
- Test: `test/doorstep.test.mjs`

**Interfaces:**
- Produces:
  - `shortlistId(query: string) -> string`: `normalisePostcode(q)` if it's a full postcode, otherwise lower-case, trimmed, with spaces collapsed.
  - `loadShortlist() -> Entry[]` (`[]` if there's no file; **throws** `Error('Shortlist file is damaged…')` if the file exists but won't parse)
  - `saveEntry(entry) -> Entry` (validates, sets `id = shortlistId(entry.query)`, replaces an entry with the same id or appends one, keeps `savedAt` from the first save, and writes atomically via a `.tmp` file plus rename)
  - `removeEntry(id) -> boolean`
  - Entry: `{ id, query, label, area, lat, lng, country, savedAt, refreshedAt, settings: {dest, faith, hideFaith, schoolRadius, priceRadius, priceYears, priceSize}, snapshot }`
  - Routes: `GET /api/shortlist` → `{ entries }`; `POST /api/shortlist` (body = entry) → `{ saved }`; `DELETE /api/shortlist?id=` → `{ removed }`. Raise `readBody`'s cap to 50 kB for this route only.

- [ ] **Step 1: Write failing tests**, in the temp-project pattern so `DATA_DIR` points at a temp `data/`:

```js
test('shortlist: save, update by id, remove', async () => {
  const a = saveEntry({ query: 'sg51nz', label: 'SG5 1NZ', lat: 51.95, lng: -0.28, settings: {}, snapshot: {} });
  assert.equal(a.id, 'SG5 1NZ');
  const b = saveEntry({ query: 'SG5 1NZ', label: 'SG5 1NZ', lat: 51.95, lng: -0.28, settings: {}, snapshot: { crime: { perMonth: 9 } } });
  assert.equal(loadShortlist().length, 1);
  assert.equal(b.savedAt, a.savedAt);
  assert.equal(removeEntry('SG5 1NZ'), true);
  assert.deepEqual(loadShortlist(), []);
});
test('shortlist: a damaged file is never overwritten', () => {
  fs.writeFileSync(path.join(tmpData, 'shortlist.json'), '{ not json');
  assert.throws(() => loadShortlist(), /damaged/);
  assert.throws(() => saveEntry({ query: 'Hitchin', label: 'Hitchin', lat: 51.9, lng: -0.28, settings: {}, snapshot: {} }), /damaged/);
  assert.equal(fs.readFileSync(path.join(tmpData, 'shortlist.json'), 'utf8'), '{ not json');
});
test('shortlist: bad entries are rejected', () => {
  assert.throws(() => saveEntry({ query: '', lat: 51, lng: 0 }), /place/i);
  assert.throws(() => saveEntry({ query: 'x', lat: 10, lng: 0 }), /England or Wales/);
});
```

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `lib/shortlist.mjs`** and the three routes in `server.mjs`, following the `/api/catchment` block (method check, `readBody`, `send`). Use the same lat/lng bounds as `point()`. Cap the list at 100 entries.

- [ ] **Step 4: Run** `npm test`. Expected: PASS.

- [ ] **Step 5: Commit** `feat: shortlist storage and API`

---

### Task 6: Snapshot builder

**Files:**
- Create: `public/snapshot.js` (a pure ES module with no DOM, importable by Node)
- Modify: `public/app.js` (import the shared helpers from it instead of defining them locally)
- Test: `test/doorstep.test.mjs`

**Interfaces:**
- Consumes: `state.transport`, `state.schools`, `state.prices`, `state.crime`, `state.flood` shapes as the APIs return them.
- Produces (all exported from `public/snapshot.js`):
  - `median`, `chance(s)`, `goodChance(s)`: moved from `app.js`, behaviour unchanged.
  - `walkMinutes(metres) -> number` = `Math.ceil(metres / 80)`
  - `crimeTrendPct(crime) -> number | null` (the same calculation as `trendHtml`, which now calls it)
  - `buildSnapshot({ transport, schools, prices, crime, flood }, settings, now = new Date()) -> Snapshot`
  - `mergeSnapshot(old: Snapshot, fresh: Snapshot) -> Snapshot`: for each section, `fresh[k] ?? old[k]`.
  - `bestInColumn(entries: Entry[]) -> { [column]: id[] }`: which rows get green shading.
  - Snapshot: `{ transport: { asOf, destination, station: { name, distance, walkMin } | null, door: { minutes, changes } | null } | null, schools: { asOf, radius, primary: Pick | null, secondary: Pick | null } | null, prices: { asOf, radiusM, years, sizeMin, detached: { median, count }, semi: { median, count } } | null, crime: { asOf, perMonth, trendPct } | null, flood: { asOf, covered, medHigh, verdict, label } | null }` where `asOf` is a `'YYYY-MM-DD'` string and Pick = `{ name, distance, label, estimate, likely: boolean }`.
  - Rule for choosing a school (the owner chose this): from schools within `settings.schoolRadius` (with faith schools removed if `settings.hideFaith`) where `rating.tone === 'great'`, primary = phase `Primary`, secondary = phase `Secondary`. Pick the nearest one with `goodChance`. If none, pick the nearest at all with `likely: false`.
  - Prices: apply `settings.priceSize` the way `filteredSales` does (only when `prices.epc.enabled`).
  - A section whose source is `null`, has `.error` or is not ready → `null`.
  - Columns for `bestInColumn`: `walk` (lowest `walkMin`), `door` (lowest minutes), `primary` and `secondary` (lowest distance among `likely: true` only), `detached`, `semi` (lowest median), `crime` (lowest `perMonth`), `flood` (lowest `medHigh` among `covered`). Ties shade every tied row. A column where fewer than 2 rows have a value shades none.

- [ ] **Step 1: Write failing tests.** Import from `../public/snapshot.js`. Cover:
  - `walkMinutes(600) === 8`, `walkMinutes(0) === 0`
  - School picking: an Outstanding Catholic school at 300 m with estimate `unlikely`, and an Outstanding school at 900 m with estimate `likely` → primary is the 900 m one with `likely: true`. With only the unlikely one → it's picked with `likely: false`. With `hideFaith` → the Catholic one is ignored.
  - `buildSnapshot` with `transport: null, prices: { error: 'x' }` → those sections are `null`, the others are filled, and nothing throws.
  - `mergeSnapshot({ crime: { perMonth: 9, asOf: '2026-10-12' } }, { crime: null, transport: {...} }).crime.perMonth === 9`
  - `bestInColumn`: a tie on `door` shades both, a single-valued column shades none, and an unlikely-only school never wins.

- [ ] **Step 2: Run** `npm test`. Expected: FAIL.

- [ ] **Step 3: Implement `public/snapshot.js`.** Then in `app.js`, delete the local `median`, `chance` and `goodChance` and `import { … } from './snapshot.js'`. Make `trendHtml` use `crimeTrendPct`.

- [ ] **Step 4: Run** `npm test`. Expected: PASS. Reload the app and check the schools and crime panels look exactly as before.

- [ ] **Step 5: Commit** `feat: snapshot builder shared by page and shortlist`

---

### Task 7: Save button and shortlist view

**Files:**
- Modify: `public/index.html`, `public/app.js`, `public/styles.css`

**Interfaces:**
- Consumes: the shortlist API (Task 5) and `buildSnapshot`, `mergeSnapshot`, `bestInColumn` (Task 6).
- Produces: `currentSettings() -> Settings` (read from the page controls), `fetchPlaceData(entry) -> { transport, schools, prices, crime, flood }` (calls the five APIs using the **entry's** settings, without touching `state` or the DOM), and `?view=shortlist` routing.

- [ ] **Step 1: Save button.** In `.place`, next to `#place-name`, add `<button id="save-place" class="save">☆ Save to shortlist</button>`. It shows "★ Saved" when `shortlistId` of the current query is already in the list (load `/api/shortlist` once at boot and keep it in `state.shortlist`). Clicking it while saved removes the place (same undo message as Step 3). Clicking it while not saved POSTs `{ query, label, area, lat, lng, country, settings: currentSettings(), snapshot: buildSnapshot(state, currentSettings()) }`. Copy `shortlistId` into `snapshot.js` so the browser and server agree, and test that both give the same result.

- [ ] **Step 2: Top-bar link** `<a id="shortlist-link" href="?view=shortlist">Shortlist (N)</a>`. Routing: `?view=shortlist` hides `#intro` and `#results` and shows `#shortlist`. Browser back works (`pushState` plus `popstate`).

- [ ] **Step 3: Shortlist table** (layout A): columns Place, Nearest station, Door to <destination>, Outstanding primary, Outstanding secondary, Median detached, Median semi, Crime, Flood, then the actions. Each cell has a main value plus a small grey line, as in the spec table. Price cells' small line shows the sale count and "1 km · 3 yrs". A cell for a section kept from an older refresh gets "from 12 Oct". Green shading comes from `bestInColumn`. Clicking a column heading sorts by that column, and clicking again reverses it. The default order is the order saved. Clicking the place name opens `?q=<query>&dest=<settings.dest>`. ✕ hides the row and shows "Removed <label> · Undo" for 6 s, then sends the DELETE (undo cancels it). An empty list shows "Nothing saved yet. Look up a place and press ☆ Save to shortlist."

- [ ] **Step 4: Refresh.** A per-row "Refresh" and a "Refresh all" button run one at a time. Each calls `fetchPlaceData(entry)`, then `buildSnapshot`, `mergeSnapshot(old, fresh)`, POST, and re-renders. While running, the row shows "Refreshing…". `refreshedAt` is set when the refresh finishes. Rows refreshed more than 90 days ago get a grey "may be out of date" hint.

- [ ] **Step 5: Mobile and themes.** The table sits in an `overflow-x: auto` wrapper and the page never scrolls sideways at 390 px. Pills don't wrap. Check light and dark.

- [ ] **Step 6: Verify in the browser.** Save `TN9 1RD`, `SG5 1NZ` and `Hitchin` (with `sg5 1nz` typed in lower case once, to confirm it doesn't make a duplicate). Open the shortlist and check every column is filled and the shading makes sense. Sort by Door. Remove and undo. Refresh one row, then refresh all. Stop the server mid-refresh: the old values stay, with "from …" notes, and nothing turns into "–". Restart the server: the list is still there.

- [ ] **Step 7: Commit** `feat: shortlist save button and compare view`

---

### Task 8: Docs

**Files:**
- Modify: `CLAUDE.md`, `ROADMAP.md`, `README.md` (if it describes setup)

- [ ] **Step 1: Update `CLAUDE.md`.** Layout table: `lib/flood.mjs`, `lib/unzip.mjs`, `lib/shortlist.mjs`, `public/snapshot.js`, `scripts/build-flood.mjs`. Data sources: the EA flood row (England only; WMS layers). `data/`: `flood.json` (rebuilt by setup) and `shortlist.json` (**never delete**). Cache keys: add `flood:v1`. Decisions: snapshot plus refresh, the school pick rule (owner's choice), the flood verdict thresholds, and Wales.

- [ ] **Step 2: Update `ROADMAP.md`.** Move 1 and 3 to "Already done". Suggest 2 (reverse search) next.

- [ ] **Step 3: Run** `npm test`. Expected: all pass.

- [ ] **Step 4: Commit** `docs: shortlist and flood risk`
