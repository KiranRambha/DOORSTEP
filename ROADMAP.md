# Doorstep roadmap

Ideas agreed with the owner on 16 Oct 2026. Items 1 and 3 were built on 16 Oct 2026 and item 2 on 17 Oct 2026 (see "Already done"). Last updated 17 Oct 2026. **Suggested next: 4 (broadband), small and self-contained, or the small fixes below.** Ask the owner which to do next; don't assume.

## Extra checks for a specific area

4. **Broadband.** Ofcom Connected Nations postcode data: average speeds, full-fibre availability. Important for working from home.
5. **Everyday amenities on the map.** GP surgeries (NHS ODS data), supermarkets, parks, playgrounds, leisure centres (OpenStreetMap / Overpass).
6. **Noise.** Defra strategic noise maps for road, rail and aircraft.
7. **Planning and new developments nearby.** planning.data.gov.uk and council portals. Coverage varies by council.

## Nice to have

8. **Who lives there.** Census 2021: families with children, age mix, how people commute.
9. **Price per square metre.** Needs the EPC token (floor area). A fairer way to compare areas.
10. **Air quality.** Defra monitoring data.

## Small fixes and known issues

Found while building and reviewing the shortlist and flood work. None block anything; pick up when convenient.

- **Faith "Not set" counts faith schools as Likely.** The Schools panel, the "likely school places" count and the shortlist all treat a faith school as Likely when no faith is chosen. Consider "Possible · faith priority" instead, or prompting the owner to set their faith.
- **Wales wording.** Flood shows a "No data" pill with "no data for Wales" / "Wales not covered" underneath; the design asked for the exact words "No flood data for Wales".
- **Back button after searching from the shortlist** can show the previously loaded place instead of the one in the address bar.
- **Flood panel "as at" line** keeps the previous place's date when the next lookup fails.
- **Shortlist ids for place names** treat "St Albans" and "St. Albans" as different places (postcodes are fine).
- **Zip reader** has no ZIP64 support (only matters if the EA file ever passes 4 GB; it's ~5 MB).
- **Code comment** in `lib/flood.mjs` near `loadFlood` should say a new `flood.json` needs a server restart.
- **Find places: near misses.** Over-budget stations are only counted, not listed. A "Didn't make it" list with reasons (e.g. "over budget by £60k") could help.

## Already done (for context)

Schools with Ofsted (3 inspection systems), catchment estimate plus saved cut-offs, faith setting, school-type labels, commute with step-by-step routes, house prices plus optional EPC room filter, crime (rings, trend, type filter, month hover, map dots), data dates on every panel, light/dark/mobile layouts.

- **1. Shortlist and compare** (Oct 2026): save a snapshot of a place, compare in one table with best-in-column shading, sort, refresh, undo on remove. Design: `docs/superpowers/specs/2026-10-16-shortlist-and-flood-design.md`.
- **3. Flood risk** (Oct 2026): rivers-and-sea area summary from EA postcode data, plus rivers-and-sea and surface-water map layers. England only.
- **Ofsted grades from before Sept 2019** (Oct 2026): setup also reads Ofsted's 31 Aug 2025 statistics snapshot, so ~7,000 schools that only had a short inspection ("Standards maintained") show their earlier full grade.
- **2. Find places** (Oct 2026): stations outside London within a door-to-door time of any central terminus, with a likely Good+ primary and secondary and a typical 4-bed under a chosen budget. Ranked list plus map; click through to the full view. Needs `npm run setup:stations`. Design: `docs/superpowers/specs/2026-10-17-find-places-design.md`.
- **Shortlist overall score** (17 Oct 2026): ranked by a 0–100 score from adjustable High/Medium/Low/Off weights, with strengths and weaknesses per place.
- **Find places in London zones 3–6** (17 Oct 2026): Tube, DLR and London rail stations in zones 3–6, Tube-only stations outside London, an Area setting, terraced houses counted in London.
- **Find places extras and phone fixes** (17 Oct 2026): pages of 20, a Schools filter (Outstanding primary / secondary / both), a Bedrooms filter (3+/4+/5+), room counts on 80 recent sales per station (was 40); commute for places far from London (station TfL ids plus an estimated walk); plain-English error messages; school cards, no zoom on fields, no stuck hover tint and maps kept under the header on iPhone.
- **Shortlist faith settings** (Oct 2026): each row shows the faith setting it used, a warning appears when rows differ, and "Refresh with my settings" lines them up. Pills stay readable on the green "best" shading.
