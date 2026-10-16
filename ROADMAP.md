# Doorstep roadmap

Ideas agreed with the owner on 16 Oct 2026. None are started yet. **Suggested order: 1 and 3 first (quick, immediately useful), then 2 (bigger).** Ask the owner which to do next; don't assume.

## Most useful for choosing a place

1. **Shortlist and compare.** Save places you've looked at and compare them side by side in one table: commute, schools you'd likely get into, median detached/semi price, crime per month and trend. Could live in `data/shortlist.json` via a small API, like `catchment.json`.
2. **Find places for me (reverse search).** Set limits (e.g. "≤75 min to Bank, a good school likely, 4-bed detached under £800k") and rank candidate towns and suburbs. This is Liveable's core paid feature. It needs a candidate list (e.g. ONS built-up areas or postcode districts within a commuting band), batched TfL journeys (rate limits, so cache heavily or use a TFL_APP_KEY), and the existing school/price logic per candidate. It's the biggest job.
3. **Flood risk.** Environment Agency long-term flood risk (rivers and sea, surface water) for the address. It affects buying and insurance.

## Extra checks for a specific area

4. **Broadband.** Ofcom Connected Nations postcode data: average speeds, full-fibre availability. Important for working from home.
5. **Everyday amenities on the map.** GP surgeries (NHS ODS data), supermarkets, parks, playgrounds, leisure centres (OpenStreetMap / Overpass).
6. **Noise.** Defra strategic noise maps for road, rail and aircraft.
7. **Planning and new developments nearby.** planning.data.gov.uk and council portals. Coverage varies by council.

## Nice to have

8. **Who lives there.** Census 2021: families with children, age mix, how people commute.
9. **Price per square metre.** Needs the EPC token (floor area). A fairer way to compare areas.
10. **Air quality.** Defra monitoring data.

## Already done (for context)

Schools with Ofsted (3 inspection systems), catchment estimate plus saved cut-offs, faith setting, school-type labels, commute with step-by-step routes, house prices plus optional EPC room filter, crime (rings, trend, type filter, month hover, map dots), data dates on every panel, light/dark/mobile layouts.
