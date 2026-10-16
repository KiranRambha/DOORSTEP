# Doorstep: notes for AI assistants

Read this first. It's the project's memory between sessions. Keep it up to date when you change how something works or when the owner states a new preference. The feature backlog lives in [ROADMAP.md](ROADMAP.md).

## What this is

A personal, local web app for house-hunting in England and Wales. You type a postcode or town and it shows:

- **Schools nearby** with the latest Ofsted result and a **catchment** estimate
- **Nearest stations** and the **commute into central London**, with step-by-step routes and where to change
- **Sale prices** for detached and semi-detached houses (the owner is looking for 4-bed)
- **Crime**: the doorstep compared with the wider area, the trend, a type filter and map dots
- **Flood risk**: homes at risk from rivers and the sea within about 1 km, plus EA flood map layers (England only)
- **Shortlist**: saved snapshots of places compared side by side

It was built as a free alternative to liveable.co.uk using only free government open data. It runs on the owner's Mac at `~/Developer/doorstep`.

## Run, test, refresh

```bash
npm run setup   # Ofsted results -> data/schools.json, then EA flood postcodes -> data/flood.json. Re-run monthly.
npm run setup:flood   # just the flood file (EA updates it quarterly)
npm start       # http://localhost:5173  (binds to 127.0.0.1 only)
npm test        # node:test, fully offline, every API mocked
```

- **No npm dependencies.** Plain Node 18+ (`fetch`, `node:test`) and vanilla JS in the browser. Leaflet 1.9.4 loads from cdnjs. Don't add packages without a good reason.
- Optional `.env`: `EPC_TOKEN` (enables the room-count / likely-4-bed filter), `TFL_APP_KEY`, `PORT`.
- API responses are cached in `data/cache/`. Cache keys are versioned (`transport:v2`, `crime:v2`, `prices:v1`, `flood:v2`). **Bump the version when you change the shape of cached data**, or old entries will break the page.
- `data/` is git-ignored: `schools.json`, `flood.json`, `cache/`, plus two files of the owner's own data that must **never be deleted or blanked**: `catchment.json` (saved cut-off distances) and `shortlist.json` (saved places). `lib/shortlist.mjs` refuses to write if `shortlist.json` won't parse.
- Tests: `npm test` runs `test/*.test.mjs` (`doorstep`, `flood`, `shortlist`; zip helper in `test/helpers.mjs`).

## Layout

| File | Role |
| --- | --- |
| `server.mjs` | Tiny HTTP server: static files plus `/api/lookup`, `/api/schools`, `/api/transport`, `/api/crime`, `/api/prices`, `/api/flood`, `/api/config`, `POST /api/catchment`, and `GET/POST/DELETE /api/shortlist`. Static files are sent with `Cache-Control: no-cache`. |
| `lib/sources.mjs` | Postcode/place lookup, schools near a point, TfL stations and journeys, police crime, Land Registry prices, `postcodesAround()` (shared by prices and flood) |
| `lib/flood.mjs` | Parses the EA flood CSV, sums homes at risk around a point, picks the verdict |
| `lib/shortlist.mjs` | Reads and writes `data/shortlist.json` (atomic write, never over a damaged file) |
| `lib/unzip.mjs` | Minimal zip reader for the EA download (no dependencies) |
| `lib/catchment.mjs` | Catchment estimate, saved cut-offs, faith rules |
| `lib/ofsted.mjs` | Turns Ofsted's CSV row into a rating (handles 3 inspection systems) |
| `lib/epc.mjs` | Optional EPC matching for habitable rooms and floor area |
| `lib/util.mjs` | fetch with retry/timeout, disk cache, CSV parser, geo helpers |
| `scripts/build-schools.mjs`, `scripts/build-flood.mjs` | `npm run setup` (and `setup:flood`) |
| `public/index.html`, `app.js`, `styles.css` | The whole front end (no framework) |
| `public/snapshot.js` | Pure helpers shared by the page, the server and the tests: shortlist ids, snapshot building, refresh merge, best-in-column |
| `test/*.test.mjs` | Unit plus mocked end-to-end tests |

## Data sources (all free)

| Data | Source | Notes |
| --- | --- | --- |
| Postcodes and places | api.postcodes.io | Bulk POST for geocoding; `/terminated_postcodes` for retired ones |
| Schools | Ofsted "State-funded schools inspections and outcomes: management information" | Found via the GOV.UK content API; take the latest "latest inspections" CSV. State-funded England only (no independent schools, no Wales/Estyn). |
| Stations and journeys | api.tfl.gov.uk `StopPoint` and `Journey/JourneyResults` | The Journey Planner covers National Rail into London. Plans for **next Tuesday, arriving 09:00**. |
| Prices | HM Land Registry SPARQL `landregistry.data.gov.uk/landregistry/query` | Query with `VALUES ?pc {…}` of postcodes gathered from postcodes.io around the point. STRSTARTS on postcode is too slow. Category B (non-market) sales are excluded. |
| Room counts | EPC API `api.get-energy-performance-data.communities.gov.uk` | Bearer token via GOV.UK One Login. `habitable_room_count`, `total_floor_area`. Land Registry has **no bedroom count**. |
| Crime | data.police.uk `crimes-street/all-crime` | About a 1-mile radius, roughly 2 months behind. Locations are anonymised snap points. |
| Flood risk | EA "Risk of Flooding from Rivers and Sea – Postcodes in Areas at Risk" (zip download) and WMS layers `nafra2-risk-of-flooding-from-rivers-and-sea` (`rofrs_4band`) / `nafra2-risk-of-flooding-from-surface-water` (`rofsw`) | England only. The CSV lists every postcode with ≥1 property at risk; rows like `TW9 4H*` are grouped **no-risk** postcodes and are skipped. WMS layers only draw at zoom 14+. |
| Map | OpenStreetMap tiles plus Leaflet | |

## How the tricky parts work (decisions already made)

### Ofsted ratings (`lib/ofsted.mjs`)
- **Report card** (from Nov 2025): grades per area (Exceptional > Strong > Expected > Needs attention > Urgent improvement) plus safeguarding Met / Not met.
- **Older graded inspection** (OEIF): overall 1–4. Inspections from Sept 2024 to Nov 2025 have "Not judged" overall, so the app uses the sub-grades.
- **Short (ungraded) inspection**: "School remains Good" and similar. `refineRating()` turns these into colours. It runs at load time too, so an old `schools.json` doesn't need rebuilding.

### Catchment (`lib/catchment.mjs`)
- There's no national catchment data. The estimate uses straight-line distance plus **rank among schools a child could also join**: same phase, same **entry age** (infant/primary 4, junior 7, middle 9, secondary 11, upper 13), excluding opposite-sex schools and grammar schools.
- Bands: primary sure ≤400 m / nearest ≤1 km / possible rank ≤3 and ≤1.5 km. Secondary 1 km / 3 km / 4.5 km.
- **The owner can enter a school's real "last distance offered"** (saved in `data/catchment.json`). It overrides the estimate: Inside / Outside / Borderline (±100 m).
- **Faith setting** (a dropdown saved in localStorage, sent as `?faith=`):
  - Strict faiths (Catholic, Jewish, Muslim, Hindu, Sikh) the family doesn't share → **always "Unlikely · may take others if not full"**, however close. The owner explicitly chose consistency over a distance exception. These schools also drop out of the ranking for other schools.
  - Church of England and other Christian → judged on distance, with "may have faith places".
  - Matching faith → judged on distance, with "your faith".
  - Not set → the old "faith priority" flag.
- The UI shows the school type from its age range: "First school · ages 3–9", "Middle school · ages 9–13", and so on.

### Crime (`public/app.js` → `ringStats`)
- The server sends every report as `[lat, lng, category, street, monthIdx]`, plus the previous 12 months' totals for the trend.
- The 200 m and 500 m rings are ranked against a grid of other spots within the mile **that have at least one report nearby**, which ignores fields and empty land. Don't go back to plain density versus the whole mile: that made every street look "busier".
- Crime colour is purple (`--crime`), deliberately different from the red "Inadequate" school colour.

### Flood risk (`lib/flood.mjs`)
- Sums residential counts per band for English postcodes within 1 km (`postcodesAround(..., { dense: true })`: rings at 300/600/900 m so busy towns aren't undercounted). Postcodes missing from the file have no homes at risk.
- Verdict (`FLOOD_THRESHOLDS`): no medium/high homes → "Low risk area"; ≥50 medium/high homes **or** ≥10% of nearby postcodes with any → "Higher risk"; otherwise "Some risk". Medium/high is the band insurers care about.
- Wales: `covered: false`, shown as "No flood data for Wales" (never "Low risk"). Border areas count English postcodes only and say so.
- No postcodes found is an error and isn't cached (otherwise a postcodes.io outage would cache "Low risk").
- Both EA map layers use the same blues, so the map shows one at a time (Rivers and sea | Surface water switch). Turning the layer on zooms the map to 14.

### Shortlist (`public/snapshot.js`, `lib/shortlist.mjs`)
- A row is a **snapshot** built in the browser from the data already loaded (`buildSnapshot`), with the page settings saved alongside (destination, faith, hide-faith, school radius, price radius/years/size). **Refresh** re-fetches with the entry's own settings; `mergeSnapshot` keeps the old value for any section that failed, and the cell says "from <date>".
- Ids: a normalised postcode, or the lower-cased place name, so "sg51nz" and "SG5 1NZ" are one entry.
- School columns (the owner chose this): the nearest **Outstanding** (`rating.tone === 'great'`) school in that phase that you'd **likely** get into; if none, the nearest Outstanding one with its chance shown. Fallback schools never get the green "best" shading.
- Walk time is straight-line distance at 80 m/min, rounded up.
- Remove has a 6-second undo (no `confirm()`); the DELETE is sent when the undo expires.

## UI conventions and the owner's preferences

- Light and dark themes are both required, using CSS tokens in `:root` and the dark media query. Check both.
- **Pills/chips must never wrap.** Keep the verdict word in the pill and put extra detail in a small grey line under it (`chipHtml`, `splitLabel`).
- The whole school row is clickable, and details slide open (Ofsted grades on the left, catchment box on the right). Closed detail rows are `inert`.
- Every panel says how current its data is ("Ofsted results as at…", "most recent sale recorded…", "police data up to…").
- Distances and prices use the body font with tabular numbers (no monospace).
- Custom select chevrons sit about 8px from the right edge (the owner checked this).
- Keep the map legend visible: the map column is a flex column sized to the viewport.
- The owner likes being asked before big redesigns, and likes an honest critique when asked "does it look good?".
- Plain English in the UI; no jargon such as "OEIF".

## Working on this from a cloud session (gotchas)

- The owner's Mac is reached through the remote-device tools. The project folder is `/Users/kiranrambha/Developer/doorstep`.
- **File transfer to the Mac has silently written stale content before.** After copying, always compare `sha256sum` on both sides. Staging under a **fresh path each time** (e.g. `outputs/vN/`) and committing with `force: true` has been reliable.
- The device shell can't delete or overwrite with `tar -x`. To overwrite in place, `cat new > existing`.
- Cloud sessions usually can't reach the data APIs directly. Use Claude in Chrome (from a page like example.com) to check API shapes, and run the app with mocked `fetch` (see the test file) for screenshots.
- After server-side changes the owner needs to restart `npm start`. Front-end-only changes just need Cmd+Shift+R.
