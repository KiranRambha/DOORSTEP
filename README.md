# Doorstep

A small local web app that answers "what's it like to live here?" for any postcode or town in England and Wales:

- **Schools nearby** with their latest Ofsted result (new report cards, older graded inspections and short inspections are all handled)
- **Nearest stations** and the **journey time into central London** (door to door and from each station, arriving 09:00 on a weekday)
- **House prices** for detached and semi-detached homes, with an optional filter for likely 4-bed houses
- **Crime** reported within about a mile over the last 12 months
- **Flood risk** from rivers and the sea for the area around the address, plus flood maps (England)
- A **shortlist** to save places and compare them side by side

Everything comes from free, open government data. No accounts are needed for the basics.

## Run it

You need Node.js 18 or newer (`node -v` to check).

```bash
cd ~/Developer/doorstep
npm run setup     # one-off: downloads Ofsted ratings for ~22,000 schools and EA flood data (1–2 minutes)
npm start         # then open http://localhost:5173
```

There are no packages to install. Re-run `npm run setup` once a month to pick up new inspections. `npm run setup:flood` refreshes just the flood data (the Environment Agency updates it every few months).

## Optional: filter for 4-bed houses

Land Registry records the price, date, address and type (detached, semi and so on) but **not the number of bedrooms**. The best free source for size is the Energy Performance Certificate (EPC) register, which records each home's *habitable rooms* (bedrooms plus living and dining rooms) and floor area. A 4-bed house usually has 5 or 6 habitable rooms.

1. Go to the [EPC data API guidance](https://get-energy-performance-data.communities.gov.uk/guidance/energy-certificate-data-apis) and sign in with GOV.UK One Login (free) to get a bearer token.
2. Copy `.env.example` to `.env` and paste the token after `EPC_TOKEN=`.
3. Run `npm run check` to confirm the token works, then restart with `npm start`. A **Size** filter appears in the House prices panel.

Not every home has a certificate, so some sales can't be matched. Those are hidden when the size filter is on.

## School catchment

England has no national catchment map. Most oversubscribed schools give places by straight-line distance (after children in care, siblings and sometimes faith), and the cut-off moves every year. Doorstep handles this in two ways:

- **Estimate.** Each school is marked *Likely*, *Possible* or *Unlikely* from how far away it is and how many similar schools are closer. Infant, junior, primary and secondary schools are compared only with schools that take children at the same age, and boys' and girls' schools only with schools your child could also attend. Faith schools, grammar schools and special schools are flagged because distance isn't their main rule.
- **Your figures.** Open a school and enter the council's *last distance offered* (from its admissions or allocation report). Doorstep then shows *Inside last offer*, *Outside last offer* or *Borderline* (within 100 m). These are saved in `data/catchment.json` on your computer.

- **Your faith.** Set it in the Schools panel (saved only in your browser). Catholic, Jewish, Muslim, Hindu and Sikh schools are marked *Unlikely* for families who don't share that faith, unless very close, and stop counting when ranking other schools. Church of England and other Christian schools stay distance-based with a "may have faith places" note. Schools of your own faith are treated on distance. **Hide faith schools** removes them from the list and map.

Schools you're likely to get into are outlined on the map and listed at the top of the Schools panel. Distances are measured to the school's postcode, so allow about 100 m either way.

## Crime

The Crime panel uses every street-level report from data.police.uk within about a mile, for the last 12 published months.

- **Doorstep vs wider area.** Reports within 200 m, 500 m and a mile, as a monthly average. The 200 m and 500 m figures are ranked against other spots within the mile that have reports nearby (fields and empty land are ignored), e.g. "quieter than 70% of the area".
- **Trend.** The last 12 months compared with the 12 before.
- **Filter by type.** Click a crime type (e.g. Burglary) and the figures, chart, street list and map dots all switch to it.
- **Month details.** Hover over (or tap) a month to see what was reported.
- **Show crime on map.** Purple dots sized by the number of reports at each location, with 200 m and 500 m rings around the address.

Police move each report to an anonymous nearby point, so locations are approximate.

## Flood risk

The Flood risk panel uses the Environment Agency's list of postcodes with homes at risk of flooding from rivers and the sea. It adds up the postcodes within about 1 km and shows how many homes are in each band (high, medium, low, very low), with a verdict: *Low risk area*, *Some risk* or *Higher risk*.

- It's an area estimate, not a verdict on one house. The Environment Agency says its data isn't suitable for single properties.
- Surface water (heavy rain that can't drain away) isn't in the numbers, because it isn't published by postcode. Tick **Show flood risk on map** and switch to **Surface water** to see it. The maps appear when you're zoomed in to street level.
- England only. Welsh places show "No flood data for Wales".

## Shortlist

Press **☆ Save to shortlist** next to a place's name to keep a snapshot of it: nearest station and walk, commute, the nearest Outstanding primary and secondary you'd likely get into, median detached and semi prices, crime and flood risk. **Shortlist** in the top bar compares them in one table, with the best in each column shaded green. Click a heading to sort.

- Snapshots don't change by themselves. Press **Refresh** on a row (or **Refresh all**) to update them using the settings you saved them with. If a source fails during a refresh, the old figure stays, marked "from" its date.
- Removing a place gives you a few seconds to undo.
- The list is saved in `data/shortlist.json` on your computer.

## Optional: TfL app key

The TfL API works without a key at low volume. If you see rate-limit errors, register for a free key at [api-portal.tfl.gov.uk](https://api-portal.tfl.gov.uk) and add `TFL_APP_KEY=` to `.env`.

## Where the data comes from

| What | Source | Notes |
| --- | --- | --- |
| School ratings | [Ofsted management information](https://www.gov.uk/government/statistical-data-sets/monthly-management-information-ofsteds-school-inspections-outcomes) | State-funded schools in England, updated monthly |
| Postcodes and places | [postcodes.io](https://postcodes.io) (ONS / OS open data) | |
| Stations and journeys | [TfL Unified API](https://api.tfl.gov.uk) | Journey Planner includes National Rail into London |
| Sale prices | [HM Land Registry Price Paid Data](https://landregistry.data.gov.uk) (SPARQL endpoint) | Lags 2–3 months behind completions |
| Room counts (optional) | [EPC register](https://get-energy-performance-data.communities.gov.uk) | Needs a free token |
| Crime | [data.police.uk](https://data.police.uk/docs/) | About 1 mile radius, ~2 month lag |
| Flood risk | [Environment Agency: postcodes in areas at risk](https://www.data.gov.uk/dataset/5a98b0a1-2741-4b2f-a51b-5b42f13219f2/risk-of-flooding-from-rivers-and-sea-postcodes-in-areas-at-risk2) and its flood map layers | England only, updated quarterly |
| Map | OpenStreetMap | |

Ofsted, Land Registry, police, TfL and Environment Agency data are used under the Open Government Licence v3.0. Keep the attribution in the page footer if you share or publish this.

## Project notes

- [ROADMAP.md](ROADMAP.md): ideas for what to build next
- [CLAUDE.md](CLAUDE.md): how everything works and the decisions made so far (AI assistants read this automatically)

## Project layout

```
server.mjs              web server and API routes
lib/sources.mjs         postcode lookup, schools, TfL, Land Registry, police
lib/epc.mjs             optional EPC room-count matching
lib/catchment.mjs       catchment estimate and saved cut-off distances
lib/ofsted.mjs          turns Ofsted's CSV into a rating per school
lib/flood.mjs           flood risk summary from the EA postcode file
lib/shortlist.mjs       saving and loading the shortlist
lib/unzip.mjs           reads the EA zip download (no dependencies)
scripts/build-schools.mjs   the schools part of "npm run setup"
scripts/build-flood.mjs     the flood part ("npm run setup:flood")
public/                 the web page (index.html, app.js, styles.css, snapshot.js)
data/                   downloaded data, your saved settings and a cache of API responses
```

`data/catchment.json` and `data/shortlist.json` are your own saved figures and places, so don't delete them. Everything else in `data/` can be rebuilt with `npm run setup`.

API responses are cached in `data/cache` so repeat searches are instant. Delete that folder to force fresh data.

## Limitations

- Schools: catchment is an estimate unless you enter the council's figure. Independent schools aren't in Ofsted's file. Wales has its own inspectorate (Estyn), which isn't included.
- Flood risk: rivers and the sea only in the numbers, England only, and for the area rather than a single house.
- Journey times are timetabled, not live, and assume you can walk to the station.
- Crime counts in town centres and around stations are naturally higher; compare a few places rather than reading one number on its own.
