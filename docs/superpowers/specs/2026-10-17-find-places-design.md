# Find places (reverse search): design

Roadmap item 2. Agreed with the owner on 17 Oct 2026. Calls marked **(builder's call)** or **(Claude's call)** weren't decided by the owner; everything else was.

## Intent

The owner doesn't have a list of towns yet. Today Doorstep only answers "what's this place like?" for a postcode you already know. This feature answers the question that comes first: **"where should I even look?"**

The owner thinks about it from the train line outward. A good place is somewhere they can walk to a station and be in central London within an hour, with good schools they'd actually get into, and houses they can afford. So the search starts from **stations**, not towns. Each result is "the patch of homes within walking distance of station X".

Success: the owner opens "Find places", gets a ranked list of stations in a few seconds, watches prices fill in, and clicks through to the normal Doorstep view of a promising one.

## The rules (all must pass)

1. **Commute, door to door ≤ 60 min** (a setting, default 60).
   - Door to door = walk from home to the station + the fastest journey from that station to **any** central London terminus.
   - The journey ends **on arrival at the terminus** (the owner said "any station", so no onward tube).
   - Termini: Waterloo, London Bridge, King's Cross, St Pancras, Euston, Paddington, Liverpool Street, Fenchurch Street, Victoria, Marylebone, Cannon Street, Charing Cross, Blackfriars, Moorgate, City Thameslink, Farringdon. The owner named five "like" these; the full list is **(Claude's call)**.
   - Journey planned like the existing commute: next Tuesday, arriving 09:00.
2. **Walk to the station ≤ 15 min** (a setting, default 15), at the app's usual 80 m/min straight-line.
   - **The walk allowance shrinks with the train time**: allowance = min(max walk, max door to door − train minutes). A 50-min train gets 10 min of walk (800 m); a 40-min train gets the full 15 (1,200 m).
   - If the allowance is under 5 minutes, drop the station: there's too little housing in walking range to judge **(Claude's call)**.
3. **Schools: at least one Good or Outstanding primary AND at least one Good or Outstanding secondary that you'd likely get into.**
   - Good or Outstanding = the existing `rating.tone` of `'great'` or `'good'` (this already covers report cards, older grades and short inspections via `refineRating`).
   - Likely = catchment `estimate` of `'in'` or `'likely'` (the same rule as `goodChance()` in `public/snapshot.js`), using the main page's **faith setting**.
   - Judged **from the station's location**, standing in for "a home near the station" **(Claude's call; the owner agreed to "likely to get in")**.
4. **Budget: typical 4-bed price ≤ budget.**
   - Budget is a **dropdown**, not fixed (the owner asked for this). Suggested range £400k–£1.5m in £50k steps, default £800k, remembered in localStorage **(builder's call on exact steps)**.
   - "Typical" = the **median** of standard (category A) Land Registry sales of **detached and semi-detached houses together**, from the last 3 years, within that station's walk allowance.
   - Only sales matched to an EPC with **5+ habitable rooms** count (the existing "Likely 4+ beds" filter). **Update 17 Oct 2026 (owner's choice):** room counts are checked on the 40 most recent sales per station (later raised to 80), with EPC requests spaced out, because the EPC service rate-limited a full search. The owner has `EPC_TOKEN` set. If the token is missing, fall back to all detached/semi sales and say so on the page.
   - Fewer than 5 qualifying sales: the price is **"not enough sales"**. Show the station in a separate "couldn't check price" group, not as a pass **(Claude's call)**.

**Not used as filters:** crime and flood. The owner agreed these are shown, not filtered.

## How it works

### 1. One-off setup: `npm run setup:stations` → `data/stations.json`

This is the slow part (the owner was told 20–40 minutes and accepted that). Re-run every few months.

- **Candidate stations: National Rail stations in England _outside Greater London_** (the owner chose this). London stations would add several hundred price checks, and 4-bed houses there are mostly far over budget. Elizabeth line stations outside Greater London (e.g. Shenfield, Maidenhead) count because they're National Rail stations too. Tube-only and Overground-only stations are out. Suggested pre-filter: within ~100 km of Charing Cross. "Outside Greater London" can come from postcodes.io's `region` for the station's location (anything but "London"). **(Builder's call** on the station source, e.g. TfL `StopPoint` by mode, NaPTAN or another free list, and on the radius.)
- For each station, ask the TfL Journey Planner for the fastest trip to the termini and keep the best: terminus, minutes, changes, and where you change. To cut calls, there's no need to try all 16 termini from every station (e.g. try the nearest few by straight-line distance, or stop once a trip clearly can't be beaten) **(builder's call)**.
- Keep stations whose best trip is under the **largest** door-to-door setting the UI allows (suggest up to 90 min), so the slider can go above 60 without re-running setup.
- Uses `TFL_APP_KEY` (set). Respect TfL's rate limit, retry on errors, and **resume** if interrupted: re-running shouldn't redo stations already done, via the existing disk cache or a progress file.
- Store per station: name, lat/lng, best terminus, train minutes, changes, change stations, plus a `builtAt` date and the journey date.
- Write atomically, like the other setup scripts.

### 2. A search: instant first pass, prices fill in

- **Instant (server, all local data):** the commute rule from `stations.json`, then the schools rule from `schools.json` + `addCatchment`. This gives the candidate list within a second or two.
- **Then prices, one station at a time** with a small concurrency limit (e.g. 3), **fastest train first**, so the best candidates fill in first. Each row shows "checking price…" until done, then passes or drops out. A progress line: "Checking prices: 12 of 40".
- **Cheap check before the EPC step (Claude's call):** EPC matching is the expensive part (one search per postcode plus up to 250 certificate fetches). First get the Land Registry sales. If the median of **all** standard detached + semi sales within the widest radius is already over the budget, mark the station "over budget" without running EPC. A 4-bed median is almost always higher than the all-sizes median. Run EPC only for stations that could still pass. The cached EPC results then serve later budget changes; if the budget is raised past a station's all-sizes median, that station needs its EPC step at that point.
- **EPC cap:** keep `MAX_CERT_FETCHES` as it is, but show the number of qualifying sales on each row so a thin sample is visible **(Claude's call)**.
- **EPC failures (Claude's call):** if `EPC_TOKEN` is set but the EPC service errors for a station, that station's price is **"couldn't check"**, not a fallback to all sizes (that would make places look cheaper than they are). If most stations fail, show one banner ("The energy certificate service isn't responding; try again later") rather than an error on every row. Don't cache failed EPC lookups.
- **Changing a setting must not re-fetch prices for stations already fetched.** Budget, walk and door-to-door changes are re-filters of data already held. Suggested: fetch each station's sales once at the widest radius (15 min = 1,200 m) with each sale's distance from the station, then filter by distance in the browser **(builder's call)**. Cache prices on disk as the app already does (bump to a new cache key version if the shape changes).
- **Flood** on each row: cheap (local `flood.json` + postcodes already gathered), so fetch it with prices **(Claude's call)**.
- **Crime is not shown on rows.** It costs 12+ police API calls per station. It appears when you click through to the normal view **(Claude's call, a change from the earlier "shown on each row")**.

### 3. The page (layout A: ranked list + map)

- A **"Find places"** link in the top bar next to "Shortlist" (`?view=find`).
- **Settings bar:** door to door (default 60), max walk (default 15), budget dropdown, and the existing faith setting (shared with the Schools panel). Schools are fixed at "Good+ primary and secondary, likely to get in" with no control.
- **Ranked list on the left**, best first = **shortest train time** (the owner agreed). Each row shows:
  - station name; "X min to Waterloo · 1 change at Y"; "walk up to N min"
  - the best qualifying primary and secondary (name, Ofsted word, distance from the station)
  - typical 4-bed price and how many sales it's based on; flood verdict pill
  - pills follow the existing rules: never wrap, extra detail in a small grey line under them.
- **Map on the right** with a numbered pin per passing station, the same numbers as the list. Hovering a row highlights its pin and vice versa.
- **Clicking a row** opens that station's location in the normal Doorstep view (all panels, including crime), from which the owner can ☆ save it to the Shortlist as usual.
  - **The destination dropdown switches to that station's best terminus** (the owner chose this), so the normal view's commute matches the figure that got the station into the list. Add any missing termini to `DESTINATIONS` in `lib/sources.mjs`. Only **add** keys; never rename or remove existing ones, because Shortlist entries store their destination key.
  - The place is opened by the **station's nearest postcode** (postcodes.io reverse lookup), so it gets a normal postcode Shortlist id and duplicates are caught as usual **(Claude's call)**.
  - Note: the normal view's commute is door to door from the postcode, so it can differ slightly from the station-to-terminus figure. That's expected.
- A collapsed **"Didn't make it (N)"** section listing near misses with the reason (e.g. "over budget by £60k", "no likely Good+ secondary") is useful but optional **(builder's call)**.
- **Data dates** shown like every other panel: "Train times as at <builtAt>", "Ofsted results as at…", "Sales since <date>".
- If `stations.json` is missing: a plain message telling the owner to run `npm run setup:stations`, like the schools message.
- Light and dark themes, and phone width, per the usual conventions.

### Added after the build (17 Oct 2026, owner's requests)

- **Bedrooms** setting: 3+, 4+ (default) or 5+, meaning EPC habitable rooms ≥ bedrooms + 1.
- **Schools** setting: Good or Outstanding (default), Outstanding primary, Outstanding secondary, or both.
- **Pages of 20**; the map shows only the current page's pins.

### London zones (agreed with the owner on 17 Oct 2026)

**Why:** outer London (for example Bexley, Havering, Sutton, Bromley) may have 4-bed houses under the budget. This reverses the earlier "outside London only" choice for **Greater London zones 3–6**. Zones 1–2 stay out: 4-bed houses there are almost always over £1.5m, so they'd only slow the search.

**Zones 7–9** are outside Greater London (Amersham, Shenfield, Cheshunt…). National Rail stations there are already in the list. **Tube-only stations outside Greater London** (Chesham, Epping, Loughton, Theydon Bois, Croxley, Moor Park…) were missing, because the list only read National Rail; they're added now and belong to the "Outside London" group. The owner pointed out that London has 9 zones.

**Which stations:**
- Tube and DLR stations from TfL's station list per mode (`StopPoint/Mode/tube`, `/dlr`), which includes each station's zone.
- National Rail, Overground and Elizabeth line stations in Greater London from NaPTAN (already downloaded). Their zone comes from TfL `StopPoint/{id}`, one call per station, cached.
- Inside Greater London (postcodes.io region "London"): keep a station if **any** of its zones is 3–6. "2+3" counts; "1+2" doesn't. London stations with no zone from TfL are left out, and setup logs how many.
- Outside Greater London: keep every station as before, now including Tube-only ones. Their zone (7–9), if any, is shown but not used as a filter.
- Trams are left out.
- Each station is saved with `london` (true inside Greater London) and its `zone` where TfL has one, for example "4", "2+3" or "9".

**Commute:** unchanged. Walk plus the fastest trip to any of the 16 central termini, planned station to station by TfL id. The Tube counts, for example the Northern line to London Bridge.

**Price:** in Greater London, **terraced houses count too**, because most London 4-beds are terraced. So in London it's detached, semi and terraced. Outside London it stays detached and semi. Rooms, budget and bedrooms rules are the same everywhere. Rows say which house types were counted.

**Schools:** the same rule. London catchments are often much tighter than the estimate's distance bands, so when London is shown, the page adds a note: "London school places often go by a few hundred metres: check the council's last distance offered before relying on 'likely'."

**Page:**
- A new **Area** dropdown: Outside London (default), London zones 3–6, or Both. "Outside London" means outside Greater London, so it includes zones 7–9. It's remembered like the other settings and re-filters instantly.
- Rows with a zone show it, for example "Zone 4" or "Zone 9", next to the station name.
- Flood and click-through are unchanged.

**Setup:**
- `npm run setup:stations` builds both lists. A re-run before Tuesday 20 Oct reuses the journeys already planned for stations outside London. The London part adds about 300–400 stations (about 5,000–6,500 TfL calls at the existing pace, roughly 15–25 minutes).
- If the Tube or DLR list can't be downloaded, setup stops with a clear message rather than saving a half-built London list.

**Left out on purpose:** zone 1–2 stations, trams, and London-specific catchment bands. Better London catchment data would need council figures; that's a separate idea.

## Goals, non-goals, anti-goals

**Goals:** a list of stations meeting all the rules in seconds; prices filling in live; settings changes feel instant; click through to the full view.

**Non-goals (v1):**
- A custom destination such as an office, or Bank/Canary Wharf. The existing destination dropdown is for the single-place view.
- Filtering by crime, flood, broadband and so on.
- Stations inside Greater London (the owner chose outside London only).
- Wales (no Welsh station is within an hour of London), independent schools, or bedroom counts beyond the EPC proxy.
- Ranking towns instead of stations.

**Anti-goals (would make it a failure even if it "works"):**
- **Showing a place as passing when a check couldn't run.** Unknown is never a pass: price errors, too few sales and missing data are shown as such.
- Hammering the APIs on every slider move.
- Breaking or slowing the existing place view or Shortlist.
- Touching `data/catchment.json` or `data/shortlist.json`.

## Constraints

- No npm dependencies; plain Node 18+ and vanilla JS; Leaflet from cdnjs as now.
- Tests in `test/*.test.mjs`, fully offline with mocked `fetch`. Cover at least the walk-allowance maths, the pass/fail rules (including "unknown is not a pass"), and the setup script's resume behaviour.
- Reuse `postcodesAround`, `landRegistrySales`/`prices`, `enrichWithEpc`, `addCatchment`, `goodChance` and `flood` rather than copying them.
- Bump cache key versions for any changed cached shape.
- Update `CLAUDE.md` (layout table, data sources, setup commands) and `ROADMAP.md` when done.

## Left to the builder

The station source and pre-filter radius; how many termini to try per station; how setup resumes; the exact budget steps; whether prices come in through the existing `/api/prices` per station or a new endpoint; the "Didn't make it" section; and the exact visual design within layout A.
