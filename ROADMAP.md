# Doorstep roadmap

Ideas agreed with the owner on 16 Oct 2026. Items 1 and 3 were built on 16 Oct 2026 (see "Already done"). **Suggested next: 2 (reverse search), which can reuse the shortlist's snapshot builder.** Ask the owner which to do next; don't assume.

## Most useful for choosing a place

2. **Find places for me (reverse search).** Set limits (e.g. "≤75 min to Bank, a good school likely, 4-bed detached under £800k") and rank candidate towns and suburbs. This is Liveable's core paid feature. It needs a candidate list (e.g. ONS built-up areas or postcode districts within a commuting band), batched TfL journeys (rate limits, so cache heavily or use a TFL_APP_KEY), and the existing school/price logic per candidate. It's the biggest job.

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

- **1. Shortlist and compare** (Oct 2026): save a snapshot of a place, compare in one table with best-in-column shading, sort, refresh, undo on remove. Design: `docs/superpowers/specs/2026-10-16-shortlist-and-flood-design.md`.
- **3. Flood risk** (Oct 2026): rivers-and-sea area summary from EA postcode data, plus rivers-and-sea and surface-water map layers. England only.
