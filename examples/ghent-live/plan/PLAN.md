# Plan: ghent-live, built overnight

The nightwatch run that builds this example starts from the base in this folder and
ends with one master PR plus a test plan. This file is the plan and the ticket list;
the field orchestrator mirrors the tickets into its run log.

## Goal

Ghent's historic centre, live, in 3D, by night, good enough to review in front of an
audience:

1. Open the app on the "Street level" preset at night: from the Sint-Michielsbrug,
   the three towers (Sint-Niklaas, the Belfry, Sint-Baafs) stand in a row, lit by the
   Lichtplan, with the real buildings around them.
2. The Leie and the Schelde run through the city; the circulation plan's sectors and
   its car-free core lie on the ground, with the "knips" where cars cannot pass.
3. Parking garages show how full they are, and shared-bike stations how many bikes
   they have, from the city's live feeds.
4. "Ask Ghent" answers a parking question in under a second and highlights the
   answer in the scene.
5. Every view, including the selection, the data time and the question, is in the
   URL, so a review note reproduces it.

## Milestone bar

"Testable" means, for every layer:

- **fixture mode** works offline from small files in `public/fixtures/`, and its unit
  tests and visual checks pass on them;
- **recorded mode** works from a saved snapshot (time in the URL), for the layers
  with live data;
- **live mode** works through the dev server's own routes. No browser code fetches a
  third-party feed directly.

## How the base splits the work

Every ticket owns its files; nobody else edits them. The base already contains the
shared seams, so no ticket needs to touch `main.ts`, `vite.config.ts` or the layer list.

| Seam | Where | Rule |
| --- | --- | --- |
| Layers | `src/layers/<name>.ts`, listed in `src/layers/index.ts` | One file per ticket. Implement `init`, and `update`, `notice`, `setLight`, `pick`, `select` as needed (see `src/layers/types.ts`). |
| HUD notices | `notice()` on a layer | A short line when data may not be current or is missing; null when all is well. main.ts shows them every 5 s and hides the line when there are none. |
| Day and night | `setLight(light)` on a layer | Called whenever the lighting changes and once after `init`. The Lichtplan (T4) switches its lights here. |
| Server routes | `server/routes/<name>.ts` | Each file default-exports a `Route`; all are mounted. Third-party fetches and the key live here. |
| City state | `server/city-state.ts` | The `CityState` type that T5, T6 and T3 fill and T7 reads. Owned by the base; change it only through the orchestrator. |
| Places | `src/places.ts` | The landmarks (slug, Dutch and English name, coordinates) for presets, labels, questions and the review plan. Owned by the base. |
| Shared values | `src/constants.ts` | Area, water level, ground overlay height, fixture radius. Read them; change them only in T9. |
| View state | `src/view-state.ts` | The URL hash, including `ask`. Owned by the base; ask the orchestrator before changing it. |
| Coordinates | `src/geo.ts` | `toLocal({lat, lon})` gives metres from the Belfry: x east, z south, y up. |
| UI | `src/ui/controls.ts`, `src/ask/panel.ts` | T8 and T7. Each gets `getView` and `setView`. |
| Review overlay | `GHENT_LIVE_OVERLAY` in `vite.config.ts` | The dev server adds the reviewer overlay and serves it on the app's own origin. T10 proves it end to end. |

Serialization points: `src/constants.ts`, `src/view-state.ts`, `server/city-state.ts`
and `src/places.ts` (one writer at a time, through the orchestrator); `package.json`
and `pnpm-lock.yaml` (add a dependency only in your own ticket's PR and say so in the
PR body; the orchestrator merges these one at a time); `README.md` (T9, except the
"Review it" section, which is T10's).

## Contracts

Values that cross ticket boundaries. Use them exactly; a worker who needs another
asks the orchestrator, who updates this table for everyone.

| What | Format | Example | Written by | Read by |
| --- | --- | --- | --- | --- |
| Building selection | `bldg:<OIDN>` (GRB object id) | `bldg:1362089` | T1 | T7, T9 |
| Sector selection | `sector:<slug of the sector name>` | `sector:kuip` | T3 | T7 |
| Lichtplan selection | `poi:<objectid>` | `poi:2173` | T4 | T9 |
| Garage selection | `garage:<slug of the garage name>` | `garage:vrijdagmarkt` | T5 | T7, T9 |
| Bike station selection | `bikes:<operator>:<station id>` (`donkey`, `bolt`, `blue-bike`) | `bikes:donkey:35010` | T6 | T7 |
| Landmark selection | `place:<slug>` from `src/places.ts` | `place:gravensteen` | base, T8 | T7, T9 |
| Question in the URL | `ask=<template>:<value>` | `ask=park:gravensteen`, `ask=drive:coupure~portus-ganda`, `ask=busy:now` | T7 | T9 |
| A new view | spread the current one: `setView({ ...getView(), sel })` | | everyone | |

Slugs are lower case ASCII (accents dropped): every run of characters outside `[a-z0-9]` becomes one `-` (`Sint-Michiels` → `sint-michiels`, `Portus Ganda` → `portus-ganda`).

## File budget

The master PR is reviewed by the review bot too, and the bot stops at 100 files (the
NYC run's master PR landed on 99). Every ticket has a budget, including its
screenshot fixture and recording. Count before every push
(`git diff --name-only origin/main... | wc -l`); a ticket that needs more asks the
orchestrator first. Fold several fixtures into one file where you can.

| T1 | T2 | T3 | T4 | T5 | T6 | T7 | T8 | T9 | T10 | Total |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 10 | 8 | 8 | 9 | 10 | 8 | 12 | 11 | 8 | 6 | 90 |

The master PR counts each file once, so a file two tickets touch (`README.md`,
`package.json`) counts once; the orchestrator keeps the running total in its log.

## Checks every ticket uses

- Functional: `pnpm test` with your own `test/<ticket>.test.ts`, plus the
  ticket-specific script below.
- Visual: start your own dev server on your own port, then
  `pnpm shot --hash '<a view that shows your work>' --out shots/<ticket>.png` and
  `pnpm check:visual shots/<ticket>.png checks/<ticket>.json`. Write the check file
  first, from the ticket's acceptance criteria. Iterate until every check passes.
  Use the shared browser (`GHENT_LIVE_CDP`), never a Chrome of your own (T10 is the
  one exception, see its ticket).
- Record your passing answers with `--record`, commit the screenshot as
  `test/fixtures/<ticket>.png` and add a replay test (copy `test/check-visual.test.ts`).
  CI then re-checks it without a key. A recording is keyed to the exact screenshot:
  change the screenshot, record again.
- Stop what you started by its saved PID or by your own port, never by name or
  pattern (`pkill -f "ghent-live.*vite"` stops every worker's dev server on the box).
- Gate: every CI check green (including CodeQL), 0 open code-scanning alerts on your
  files, the review bot's 5/5 on the PR head, 0 unresolved threads, 0 outstanding
  comments outside the diff. Paste the `check:visual` output and attach the
  screenshot in the PR body.
- The review bot reviews only a PR's first push. After every later push, reply to
  each finding you fixed (naming the commit), resolve the thread, and ask for a new
  review in a PR comment (`@greptile please review again`). The score counts only
  when the PR body's "Last reviewed commit" is your current head.
- A check's bar is part of the plan. Fix the app until it passes; never lower a
  `min`, never edit a check to describe what the app does instead. If a check is
  wrong, ask the orchestrator.
- Never commit downloaded data (`data/` is ignored); fixtures stay small (under
  300 KB each).

## Tickets

Wave 1 is T1, T2, T3, T7, T8 and T10 (six workers, the cap). T5, T4 and T6 take the
first free slots, in that order. T9 starts when all others are merged into the
integration branch.

### T1. Buildings

- **Owns:** `src/layers/buildings.ts`, `scripts/fetch-buildings.ts`,
  `public/fixtures/buildings.json`, `checks/buildings.json`, `test/buildings.test.ts`.
- **Build:** download the building footprints for `AREA` from Digitaal Vlaanderen's
  GRB WFS (`https://geo.api.vlaanderen.be/GRB/wfs`, type `GRB:GBG`, GeoJSON output).
  Request them twice, in `EPSG:4326` for drawing and in `EPSG:31370` (Belgian Lambert
  72) for heights, and join the two on `OIDN`: the server does the datum shift, so
  the script needs no projection code. Heights come from the DHMV II elevation model
  (`https://geo.api.vlaanderen.be/DHMV/wcs`, WCS 2.0.1, coverages `DHMVII_DSM_1m` and
  `DHMVII_DTM_1m`, `GetCoverage` with `subset=x(…)&subset=y(…)` in Lambert 72; the
  answer is a GeoTIFF, possibly wrapped in `multipart/related`). A building's height
  is a high percentile (say the 90th) of surface minus terrain inside its footprint;
  fetch the rasters in tiles, not one request per building. The `geotiff` package is
  allowed. Write `data/buildings.json` and a fixture of the buildings within
  `FIXTURE_RADIUS_M` of the Belfry. Draw extruded buildings merged into a few meshes,
  coloured by height. `pick` returns `bldg:<OIDN>`; `select` highlights it.
- **Verify:** the fixture has at least 300 buildings; unit tests for the footprint
  conversion, the height sampling on a tiny synthetic raster, and the OIDN lookup; a
  sanity test that the Belfry's footprint comes out 80 to 100 m tall; `check:visual`
  on the default view: "dense blocks of 3D buildings of varying heights", "a tall
  tower stands at the red ring", "one building is highlighted" (with a `sel`).
- **Done:** the full area (live data) draws in under 5 s on a laptop GPU, and the
  fixture view passes its checks.

### T2. Ground, water and streets

- **Owns:** `src/layers/ground.ts`, `scripts/fetch-ground.ts`, `public/fixtures/ground.json`,
  `checks/ground.json`, `test/ground.test.ts`.
- **Build:** from the GRB WFS: water surfaces (`GRB:WTZ`; check that they trace the
  Leie along the Graslei and the Schelde) at `WATER_LEVEL_M`, road surfaces
  (`GRB:WBN`) as a slightly lighter ground, and the rest of `AREA` as land. Replace the
  placeholder grid.
- **Verify:** unit tests for the polygon conversion and triangulation;
  `check:visual` from above (`#cam=0,2200,1&tgt=0,0,0`): "a river runs through the
  city", "streets form an irregular, medieval pattern, not a grid", "no plain square
  grid is visible".

### T3. Circulation plan

- **Owns:** `src/layers/circulation.ts`, `scripts/fetch-circulation.ts`,
  `public/fixtures/circulation.json`, `checks/circulation.json`, `test/circulation.test.ts`.
- **Build:** from Stad Gent open data (`https://data.stad.gent/api/explore/v2.1/`):
  `sectoren-circulatieplan-gent` (the sectors, the car-free area and pedestrian
  streets) and `knips-circulatieplan-gent` (the "knips": posts and short lines where
  cars cannot cross). Sectors as translucent patches on the ground at
  `GROUND_OVERLAY_Y_M`, adjacent sectors in different colours and the car-free area in
  its own; sector names as labels when seen from above; knips as red posts. `pick`
  returns `sector:<slug>`. Export the sector names for the city state.
- **Verify:** unit tests for the colouring (no two neighbours share a colour) and the
  slugs; `check:visual` from above: "coloured zones surround the centre", "a distinct
  zone lies in the middle", "small red posts stand on zone borders".

### T4. Lichtplan

- **Owns:** `src/layers/lichtplan.ts`, `scripts/fetch-lichtplan.ts`,
  `public/fixtures/lichtplan.json`, `checks/lichtplan.json`, `test/lichtplan.test.ts`.
- **Build:** from Stad Gent open data: `points-of-interest-poi-lichtplan-gent` (67
  points) and `route-lichtplan-gent` (the walk, 7 lines). At night (`setLight`), the
  points glow warm: at most 8 real lights on the towers and bridges, the rest
  emissive sprites; the walk is a glowing line at street level. By day, small
  markers and a thin line. `pick` returns `poi:<objectid>`.
- **Verify:** unit tests for the parsing and the choice of the 8 lit points;
  `check:visual` at night (`light=night`): "warm lights shine on towers and
  buildings", "a glowing path runs through the streets"; and by day, as a negative
  control, "no glowing path is visible" passes at a low probability.

### T5. Parking garages, live

- **Owns:** `src/layers/parking.ts`, `server/routes/parking.ts`, `scripts/record-parking.ts`,
  `public/fixtures/parking.json`, `public/fixtures/parking/` (recorded snapshots),
  `checks/parking.json`, `test/parking.test.ts`.
- **Build:** `GET /api/parking` reads `bezetting-parkeergarages-real-time` (15 garages,
  with capacity, availability and the time of the last update) on the server; cache
  60 s. One column per garage inside `AREA`: its height is the capacity, its filled
  part the occupied places, its colour the share still free. `record-parking.ts` saves
  snapshots for recorded mode (`mode=recorded&t=…`). `notice()` says so when the data
  is more than 15 minutes old. `pick` returns `garage:<slug>`. Exports the garages in
  the `CityState` shape.
- **Verify:** unit tests for the parsing (the coordinates sit inside a JSON string in
  `locationanddimension` as well as in `location`) and the staleness notice;
  `check:visual`: "columns of different heights stand in the city", "the columns are
  partly filled".

### T6. Shared bikes

- **Owns:** `src/layers/bikes.ts`, `server/routes/bikes.ts`, `public/fixtures/bikes.json`,
  `checks/bikes.json`, `test/bikes.test.ts`.
- **Build:** `GET /api/bikes` merges, on the server, Stad Gent's datasets for Donkey
  Republic (`donkey-republic-deelfietsen-stations-locaties` and
  `donkey-republic-beschikbaarheid-deelfietsen-per-station`), Bolt
  (`bolt-status-deelfietsstations-gent`) and Blue-bike (the `blue-bike-deelfietsen-…`
  station datasets); cache 60 s. One thin bar per station inside `AREA`, height by the
  bikes available, one colour per operator. `pick` returns `bikes:<operator>:<id>`.
  Exports the stations in the `CityState` shape.
- **Verify:** unit tests for the merge (a station without availability shows 0, not
  an error); `check:visual`: "thin vertical bars in two or more colours stand along
  the streets".

### T7. Ask Ghent

- **Owns:** `src/ask/*` (its styles in its own CSS file), `server/routes/ask.ts`,
  `server/city-state-fixture.ts`, `checks/ask.json`, `test/ask.test.ts`.
- **Build:** `POST /api/ask` turns a question template plus the current `CityState`
  into one Decisions API request (`server/decisions.ts`) and returns the answer with
  its probabilities. Templates: `park:<place>`, "Where should I park to reach
  <place>?" (choice: the nearest garages with space, or a shared bike);
  `drive:<sector>~<sector>`, "Can I drive from one sector to the other without
  leaving the R40 ring road?" (predicate); `busy:now`, "Is the centre busy right now?"
  (predicate, from garage occupancy); and a free yes/no question about the current
  state. The question is stored in the URL as `ask`, and the chosen garage is
  selected (`garage:<slug>`). T7 ships a fixture `CityStateProvider`; T9 wires the
  live one. The panel's text is 24px or larger; the key stays on the server.
  `mountAskPanel` resolves once a question from the URL shows its answer.
- **Verify:** unit tests with recorded Decisions answers (`--replay`); a request
  takes under a second warm; `check:visual` with `ask=park:gravensteen`: "a panel on
  the right shows a question and an answer with a percentage".

### T8. Camera, labels and controls

- **Owns:** `src/ui/*` (its styles in its own CSS file, imported from
  `controls.ts`; `src/style.css` stays the base's), `checks/ui.json`, `test/ui.test.ts`.
- **Build:** presets with a smooth fly-to: Belfort, Graslei, Gravensteen, Sint-Baafs,
  From above, and Street level (on the Sint-Michielsbrug at eye height, looking east
  at the three towers). Layer toggles, the day/night switch (`light` in the URL),
  labels for the landmarks in `src/places.ts` at 24px or more. Everything also works
  by touch. A preset changes the camera only (spread the view).
- **Verify:** unit tests for the preset maths and that each preset survives a round
  trip through the URL; one `check:visual` per preset, each including "the on-screen
  text is readable from the back of a room" (score, at least "acceptable"); for
  Street level, "three towers stand in a row". Paste every preset's output in the PR
  body, but commit the screenshot and recording of two presets only (Street level and
  From above), to keep within the file budget.

### T9. Integration and review plan (after all)

- **Owns:** integration fixes, `src/constants.ts` tuning, `server/city-state-live.ts`,
  `README.md` (except "Review it"), `plan/review-plan.json`, `checks/stage.json`.
- **Build:** wire T5's and T6's data and T3's sector names into a live
  `CityStateProvider` for T7; tune the constants so buildings, water, zones and
  lights read clearly together at night; check memory and frame time with everything
  on (`window.__ghentLive.stats()`); write the morning test plan
  (`plan/review-plan.json`, schema in the `human-review` skill) with steps that each
  open a URL hash, starting with Street level at night. The overlay reads it with
  `--plan <absolute path>`.
- **Verify:** the full suite: every ticket's checks on the integrated app, plus
  `checks/stage.json` on Street level at night: "the three towers are lit", "the
  panel answers a parking question". A check that fails on the integrated app is a
  bug to fix in the app, not a check to edit.

### T10. Review in the app

- **Owns:** `scripts/review-e2e.ts`, `checks/review-note.json`, `test/review-e2e.test.ts`,
  the "Review it" section of `README.md`.
- **Build:** one command that proves a person can review the app with the reviewer
  overlay (`/human-review`). It starts its own throwaway mesh (its own Redis, its own
  `AGENT_MESH_HOME` under `/tmp` with a short name, because a Unix socket path may
  not exceed 108 bytes; never the run's mesh), registers a reviewer agent, starts the
  overlay server for the app's origin on a free port, a dev server with
  `GHENT_LIVE_OVERLAY`, and its own short-lived headless Chrome that accepts tab
  capture (`--auto-accept-this-tab-capture`, as in `reviewer-overlay/e2e/run.sh`; the
  shared browser cannot). It opens the default view at night with `sel=place:belfort`,
  opens the Reviewer panel, drops a pin on the red ring, sends a note, then reads the
  reviewer's inbox and stops everything it started, by PID.
- **Verify:** the note arrives with the comment, a page URL whose hash parses to the
  view that was open, and a screenshot. `check:visual` on that screenshot:
  "a 3D city scene is visible, not a blank or black canvas", "a numbered pin marker
  is drawn on the image". The command exits 0 only when all of that holds.
- **Done:** reviewing the app needs only the two commands in "Review it", and they
  also work through a proxy (a second `--origin` plus `GHENT_LIVE_ALLOWED_HOSTS`).

## Out of scope

Accounts, saved data on a server, deployment, trams and trains (De Lijn's feeds need
a key), and anything outside `examples/ghent-live/`.
