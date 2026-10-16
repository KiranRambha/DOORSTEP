# Shortlist and compare, plus flood risk

Design agreed with the owner on 16 Oct 2026. Covers roadmap items 1 and 3. Build the flood data first (the shortlist has a flood column), then the shortlist.

## Why

The owner looks up several places and can't remember how they compared. What they actually weigh up, in their words: getting to the nearest station, the commute, how near a very good (Outstanding) school is, detached and semi prices, and crime. Flood risk matters for buying and insurance, and the owner wants a feel for **the wider area**, not a verdict on one house.

Success: open one page and see every saved place side by side on those things, without re-running each search.

## Goals

- Save the place you're looking at to a shortlist with one click.
- A shortlist page with **one row per place** (the owner picked this over one column per place).
- Each row is a **snapshot** taken when you save, with a **Refresh** button to update it.
- A flood panel on the main page: an area summary for rivers and sea, and a tickbox that draws the Environment Agency's flood maps (rivers and sea, plus surface water) on the map.

## Non-goals

- Flood risk for a single property. The EA says its data isn't suitable for that, and the owner wants the area view.
- A surface-water area summary. The EA doesn't publish surface water by postcode; it's map only.
- Live shortlist rows that recompute every time the page opens (too many slow TfL calls).
- Sharing the shortlist or syncing it between devices.

## Anti-goals (would count as a failure even if it works)

- Pills that wrap, jargon in the UI, a panel without a "data as at" line, or broken dark mode (see CLAUDE.md conventions).
- Losing saved places. `data/shortlist.json` is precious, like `data/catchment.json`. Never delete or rebuild it.
- Adding npm dependencies.

## Part 1: Flood risk

### Data (checked on 16 Oct 2026)

**Rivers and sea, postcode level.** "Risk of Flooding from Rivers and Sea – Postcodes in Areas at Risk", Open Government Licence.
- Download: `https://environment.data.gov.uk/api/file/download?fileDataSetId=97781741-2982-4802-af2e-313fe3fd8f7e&fileName=RoFRS_Postcodes_in_Areas_at_Risk.zip` (4.8 MB zip; file dated 12 June 2026; dataset updated quarterly).
- Inside: `RoFRS_Postcodes_in_Areas_at_Risk/DATA/NaFRA2client.RoFRS_Postcodes_AtRisk.csv` (17 MB, ~270k rows, UTF-8 with BOM) plus a product description PDF.
- Columns used: `PC` (postcode), `RES_cntpc` (residential properties in the postcode), and `RES_CNT_High`, `RES_CNT_Medium`, `RES_CNT_Low`, `RES_CNT_VeryLow`. (`NRP_` = non-residential, `UNC_` = unclassified, `TOT_` = all; ignore these.)
- Bands: high > 3.3% chance a year; medium 1–3.3%; low 0.1–1%; very low < 0.1%.
- **A postcode missing from the file has no properties in a rivers-and-sea risk area.** It does not mean no flood risk from other sources.
- Attribution required: "© Environment Agency copyright and/or database right 2026. All rights reserved." (or the wording in the product description).

**Map layers (WMS, both support EPSG:3857, so Leaflet's `L.tileLayer.wms` works directly):**
- Rivers and sea: `https://environment.data.gov.uk/spatialdata/nafra2-risk-of-flooding-from-rivers-and-sea/wms`, layer `rofrs_4band`
- Surface water: `https://environment.data.gov.uk/spatialdata/nafra2-risk-of-flooding-from-surface-water/wms`, layer `rofsw`
- A test GetMap returned `200 image/png`. The builder should check how the layer styles look in light and dark themes, and confirm the colours have a legend (GetLegendGraphic) or write a simple one.

### Setup

- New script `scripts/build-flood.mjs`, run as part of `npm run setup` and also on its own as `npm run setup:flood`.
- Download the zip, extract the CSV **with no new dependencies** (builder's call: a small zip reader using `zlib.inflateRawSync`, or the macOS `unzip` command; prefer the pure-Node route so tests stay offline and portable).
- Write `data/flood.json`: `{ source, fileDate, builtAt, postcodes: { "TN9 1RD": [res, high, medium, low, veryLow], … } }`. Use the same normalised postcode format as `lib/util.mjs` `normalisePostcode`.
- If the file is missing at runtime, the flood panel shows "Flood data isn't downloaded yet. Run `npm run setup:flood`", like schools do.

### Server

- `GET /api/flood?lat&lng`: gather postcodes within **1 km** using the existing `postcodesAround()` in `lib/sources.mjs`, look each one up in `flood.json`, and return:
  - `postcodesChecked`, `postcodesAtRisk`
  - homes at risk by band: `{ high, medium, low, veryLow }`
  - `homesInAtRiskPostcodes` (sum of `RES_cntpc` for at-risk postcodes)
  - `source`, `fileDate`
- Cache key `flood:v1`.
- **Wales (my call):** the EA file covers England only. Use postcodes.io's `country` for the place. In Wales, return `{ covered: false }` and the panel, glance item and shortlist column say "No flood data for Wales". Near the border, count only English postcodes and add a note that Welsh postcodes aren't included.
- **Sampling (my call):** `postcodesAround()` samples sparsely at 1 km (centre plus 6 points, max 100 postcodes each), which undercounts in dense towns. For flood, sample more densely (e.g. add a 300 m ring and a 900 m ring) through a new option, without changing what prices uses or their cache.
- Honest denominator: the file only counts homes in **at-risk** postcodes, so we can't give "x% of all homes". Phrase it as homes at risk plus "N of M nearby postcodes".

### Front end

- New panel "Flood risk" in the main column, after Crime.
  - Headline: homes at **medium or high** risk within about 1 km (that's the band insurers care about), with a verdict pill: "Low risk area" / "Some risk" / "Higher risk". The exact thresholds are the builder's call. Suggestion: none at medium/high → Low; 1–49 → Some; ≥ 50, or ≥ 10% of postcodes with medium/high homes → Higher. Write the thresholds down as constants.
  - A small table or bar of homes by band (high, medium, low, very low).
  - Sub line: "Rivers and sea · Environment Agency data as at June 2026 · area estimate, not for a single house".
  - Note that surface water isn't included in the numbers and is on the map.
- Tickbox "Show flood risk on map" in the panel header, like "Show crime on map". It switches on both WMS layers with a small legend: rivers and sea in one colour family, surface water in another. Keep them visually distinct from crime purple and school colours.
- Add a "Flood risk" item to the at-a-glance strip (homes at medium/high risk nearby).

## Part 2: Shortlist and compare

### Saving

- A "☆ Save to shortlist" button next to the place name in the results header. It becomes "★ Saved" (click to remove) when the place is already on the list.
- Saving builds a **snapshot** from the data already loaded on the page and POSTs it to the server. If a section is still loading or failed, save what's there and mark the gap with "–".

### Storage

- `data/shortlist.json`, written by the server, same pattern as `catchment.json`: `GET /api/shortlist`, `POST /api/shortlist` (add or update one entry), `DELETE /api/shortlist?id=…`. Accept writes from localhost only (the server already binds to 127.0.0.1). Validate the body size (the existing `readBody` caps it at 10 kB; raise it moderately if a snapshot needs more).
- Each entry: `id` (normalised query), `query` (what was typed, used to reopen the place), `label`, `area`, `lat`, `lng`, `savedAt`, `settings` (destination, faith, hide-faith-schools tickbox, school radius, price radius and years, size filter), and `snapshot` (below).

### Snapshot columns (left to right, as in mockup A)

| Column | Content | "Best" for green shading |
|---|---|---|
| Place | Label, area, "saved 12 Oct" | – |
| Nearest station | Name, distance, **estimated walk time** (straight-line distance at 80 m/min, rounded up) | Shortest walk |
| Door to destination | Minutes, changes ("direct" / "1 change") | Fewest minutes |
| Nearest Outstanding primary | The nearest Outstanding school with a "likely" chance or better (`goodChance()`). If there isn't one, the nearest Outstanding school with its chance pill (e.g. "Unlikely"). Name, distance, pill. | Nearest with a likely chance; rows with only a fallback school never win |
| Nearest Outstanding secondary | Same | Same |
| Median detached | Price, number of sales | Lowest |
| Median semi | Price, number of sales | Lowest |
| Crime | Crimes per month within about a mile, trend arrow (↑ ↓ →) with % | Lowest per month |
| Flood | Homes at medium or high risk within 1 km, plus the verdict pill | Fewest |

- The owner chose "nearest you'd likely get into" over "nearest regardless of chance" (16 Oct 2026).
- "Outstanding" means `rating.tone === 'great'`, which already covers Outstanding, "School remains Outstanding" and top report-card grades. Search within the school radius the main page uses (3 km default). If none, show "None within 3 km".
- The chance pill uses the existing catchment wording (`chance()`, `chipHtml`) and must not wrap.
- Prices use the main page's price settings at the time of saving. Show them in a small grey line or tooltip so a 1 km/3 yr row isn't silently compared with a 1.5 km/5 yr row.

### Shortlist page

- Opened from a "Shortlist (3)" link in the top bar. A view inside the existing single page (e.g. `?view=shortlist`) is preferred to a second HTML file; builder's call.
- One row per place, as in mockup A, sortable by clicking a column heading (default: order saved).
- Each row has: click the place to open its full page; ✕ to remove; "Refresh".
- **Removing (my call):** no browser `confirm()`. ✕ hides the row and shows an "Removed TN9 1RD · Undo" message for about 6 seconds. The DELETE is only sent after that.
- "Refresh all" at the top. Refresh re-fetches the place's data in the background with the **settings saved on that entry** and rebuilds the snapshot with the same code that builds it on save. Run refreshes one at a time to stay kind to TfL.
- **Partial failures on refresh (my call):** never overwrite a good value with "–". Each section of the snapshot (transport, schools, prices, crime, flood) carries its own `asOf` date. On refresh, a section that fails keeps its old value, and the cell gets a small grey "from 12 Oct" note.
- Each row shows when it was last refreshed. Rows older than about 3 months get a gentle "may be out of date" hint.
- Works on mobile: the table scrolls sideways inside its own box; the page itself must not scroll sideways.
- Light and dark themes.

### Where the snapshot logic lives

The browser already turns raw API data into these numbers (median, crimes per month, trend, nearest school, chance). Build the snapshot in `public/app.js` by reusing those functions, so the shortlist and the main page can never disagree. The server just stores what it's sent. (This is my call, not the owner's.)

## Tests

`node:test`, offline, `fetch` mocked, matching `test/doorstep.test.mjs`:
- Flood CSV parsing (BOM, header) and the zip extraction.
- `/api/flood` summary from a small fake `flood.json`, including a point where no nearby postcode is in the file.
- Shortlist API: add, update (same id replaces), delete, a bad body is rejected, and the file survives a restart.
- Snapshot builder: picks the nearest Outstanding school per phase, walk-time rounding, handles missing sections.

## Docs to update when done

- `CLAUDE.md`: new files, `data/flood.json`, `data/shortlist.json` (never delete), the flood data source, and the `flood:v1` cache key.
- `ROADMAP.md`: move items 1 and 3 to "Already done".
- `README` setup notes if `npm run setup` changes.
- Add `.superpowers/` to `.gitignore` (brainstorm mockups).

## Left to the builder

Exact flood verdict thresholds (as constants), legend colours, zip extraction method, whether the shortlist is a view or a page, and sort behaviour details.
