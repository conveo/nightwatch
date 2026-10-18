# Plan: nyc-live, built overnight

The nightwatch run that builds this example starts from the base in this folder and
ends with one master PR plus a test plan. This file is the plan and the ticket list;
the field orchestrator mirrors the tickets into its run log.

## Goal

Lower Manhattan, live, in 3D, good enough to review in front of an audience:

1. Open the app on the "Venue" preset: 598 Broadway with real buildings around it.
2. The subway lines run below the streets in their own colours; trains move along
   them in real time (live mode) or from a saved feed (recorded mode).
3. Citi Bike docks show how many bikes are available.
4. "Ask the city" answers a route question in under a second and highlights the
   answer in the scene.
5. Every view, including the selection and the data time, is in the URL, so a review
   note reproduces it.

## Milestone bar

"Testable" means, for every layer:

- **fixture mode** works offline from small files in `public/fixtures/`, and its unit
  tests and visual checks pass on them;
- **recorded mode** works from a saved feed (time in the URL);
- **live mode** works through the dev server's own routes. No browser code fetches a
  third-party feed directly (the MTA's terms require that, see README.md).

## How the base splits the work

Every ticket owns its files; nobody else edits them. The base already contains the
shared seams, so no ticket needs to touch `main.ts`, `vite.config.ts` or the layer list.

| Seam | Where | Rule |
| --- | --- | --- |
| Layers | `src/layers/<name>.ts`, listed in `src/layers/index.ts` | One file per ticket. Implement `init`, and `update`, `summary`, `pick`, `select` as needed (see `src/layers/types.ts`). |
| Server routes | `server/routes/<name>.ts` | Each file default-exports a `Route`; all are mounted. Keys and third-party fetches live here. |
| Shared values | `src/constants.ts` | Area, subway depth, ground opacity, fixture radius. Read them; change them only in T8. |
| View state | `src/view-state.ts` | The URL hash. Owned by the base; ask the orchestrator before changing it. |
| Coordinates | `src/geo.ts` | `toLocal({lat, lon})` gives metres from the venue: x east, z south, y up. |
| UI | `src/ui/controls.ts`, `src/ask/panel.ts` | T7 and T6. |
| Review overlay | `NYC_LIVE_OVERLAY` in `vite.config.ts` | The dev server adds the reviewer overlay and serves it on the app's own origin. T9 proves it end to end. |

Serialization points: `src/constants.ts` and `src/view-state.ts` (one writer at a
time, through the orchestrator); `package.json` and `pnpm-lock.yaml` (add a dependency
only in your own ticket's PR and say so in the PR body; the orchestrator merges these
one at a time); `README.md` (T8 only).

## Checks every ticket uses

- Functional: `pnpm test` with your own `test/<ticket>.test.ts`, plus the
  ticket-specific script below.
- Visual: start your own dev server on your own port, then
  `pnpm shot --hash '<a view that shows your work>' --out shots/<ticket>.png` and
  `pnpm check:visual shots/<ticket>.png checks/<ticket>.json`. Write the check file
  first, from the ticket's acceptance criteria. Iterate until every check passes.
  Use the shared browser (`NYC_LIVE_CDP`), never a Chrome of your own.
- Record your passing answers with `--record`, commit the screenshot as
  `test/fixtures/<ticket>.png` and add a replay test (copy `test/check-visual.test.ts`).
  CI then re-checks it without a key.
- Gate: CI green, the review bot's 5/5 on the PR head, 0 unresolved threads, 0
  outstanding comments outside the diff. Paste the `check:visual` output and attach
  the screenshot in the PR body.
- The review bot reviews only a PR's first push. After every later push, reply to
  each finding you fixed (naming the commit), resolve the thread, and ask for a new
  review in a PR comment (`@greptile please review again`). The score counts only
  when the PR body's "Last reviewed commit" is your current head.
- Never commit downloaded data (`data/` is ignored); fixtures stay small (under
  300 KB each). Keep every PR under 100 files: the review bot stops there.

## Tickets

Wave 1 is T1, T2, T3, T5, T6, T7, T9 and T10. With at most 6 workers at a time,
T9 and T10 take the first free slots. T4 starts when T3 is merged into the integration
branch; T8 starts when all others are.

### T1. Buildings

- **Owns:** `src/layers/buildings.ts`, `scripts/fetch-buildings.ts`,
  `public/fixtures/buildings.json`, `checks/buildings.json`, `test/buildings.test.ts`.
- **Build:** download footprints and roof heights for `AREA` from NYC Open Data
  (BUILDING, dataset `5zhs-2jue`, Socrata API: `the_geom`, `heightroof` in feet,
  `bin`); convert to local metres; write `data/buildings.json` and a fixture of the
  buildings within `FIXTURE_RADIUS_M` of the venue. Draw extruded buildings, merged
  into a few meshes; colour by height. `pick` returns `bin:<BIN>`; `select` highlights
  that building. The venue (`VENUE.bin`) stands out.
- **Verify:** `node scripts/fetch-buildings.ts --fixture` writes a fixture with at
  least 100 buildings; unit tests for the footprint conversion and the BIN lookup;
  `check:visual` on the Venue view: "dense blocks of 3D buildings of varying heights",
  "the red pin stands among buildings", "one building is highlighted" (with
  `sel=bin:1007945`).
- **Done:** the full area (live data) draws in under 5 s on a laptop GPU, and the
  fixture view passes its checks.

### T2. Ground, water and streets

- **Owns:** `src/layers/ground.ts`, `scripts/fetch-ground.ts`, `public/fixtures/ground.json`,
  `checks/ground.json`, `test/ground.test.ts`.
- **Build:** Manhattan's land from NYC Open Data borough boundaries (clipped to the
  shoreline), water around it, the street centrelines as thin lines. Replace the
  placeholder grid. The ground uses `GROUND_OPACITY`, so the subway shows through.
- **Verify:** unit tests for the polygon conversion; `check:visual` from above
  (`#cam=0,3500,1&tgt=0,0,0`): "land is surrounded by water on the west and east",
  "a street grid is visible", "no plain square grid is visible".

### T3. Subway network

- **Owns:** `src/layers/subway.ts`, `scripts/fetch-subway.ts`, `public/fixtures/subway.json`,
  `checks/subway.json`, `test/subway.test.ts`.
- **Build:** from the MTA's static GTFS (`shapes.txt`, `routes.txt` with
  `route_color`, `stops.txt`): every line inside `AREA` as a tube at
  `SUBWAY_DEPTH_M` in its route colour, stations as small markers. Export the shapes
  and stops (with ids) for T4.
- **Verify:** unit tests for shape parsing and colours; `check:visual` from above:
  "coloured lines run under the streets", "the yellow N/Q/R/W line passes next to
  the red pin" (Prince St is beside the venue).

### T4. Live trains (after T3)

- **Owns:** `src/layers/trains.ts`, `server/routes/mta.ts`, `scripts/record-feeds.ts`,
  `public/fixtures/trains/`, `checks/trains.json`, `test/trains.test.ts`.
- **Build:** `GET /api/mta/<feed>` fetches the MTA GTFS-realtime feed on the server,
  decodes it (`gtfs-realtime-bindings`) and returns simplified trips; cache 15 s.
  Trains are drawn as short coloured blocks on T3's shapes, positioned from trip
  updates and interpolated between stops; refresh every 30 s in live mode.
  `record-feeds.ts` saves snapshots for recorded mode (`mode=recorded&t=…`). When the
  data is more than a minute old, the HUD says the positions may not be real time.
- **Verify:** unit tests decode a saved protobuf and place a train between two stops;
  `check:visual` in recorded mode: "train-coloured blocks sit on the subway lines",
  "a notice says positions may not be real time" (with an old `t`).

### T5. Citi Bike

- **Owns:** `src/layers/citibike.ts`, `server/routes/citibike.ts`,
  `public/fixtures/citibike.json`, `checks/citibike.json`, `test/citibike.test.ts`.
- **Build:** `GET /api/citibike` reads GBFS `station_information` and
  `station_status` on the server (cache 30 s). One bar per dock inside `AREA`, height
  by bikes available, e-bikes in a second colour.
- **Verify:** unit tests for the GBFS merge; `check:visual`: "vertical bars of
  different heights stand at street corners".

### T6. Ask the city

- **Owns:** `src/ask/*`, `server/routes/ask.ts`, `server/city-state.ts`,
  `checks/ask.json`, `test/ask.test.ts`.
- **Build:** `POST /api/ask` turns a question template plus the current city state
  into one Decisions API request (`server/decisions.ts`) and returns the answer with
  its probabilities. Templates: the fastest way from the venue to a named place
  (choice: a subway line, Citi Bike, or walk), whether a line runs normally
  (predicate), and a free yes/no question about the current state (predicate). The
  city state comes from a `CityState` provider; T6 ships a fixture provider, T8 wires
  the live one. The panel (24px text) shows the answer and its probability; the key
  stays on the server.
- **Verify:** unit tests with recorded Decisions answers (`--replay`); a request
  takes under a second warm; `check:visual`: "a panel on the right shows a question
  and an answer with a percentage".

### T7. Camera, labels and controls

- **Owns:** `src/ui/*`, `checks/ui.json`, `test/ui.test.ts`.
- **Build:** presets with a smooth fly-to (Venue, Battery, Brooklyn Bridge, From
  above, Street level), layer toggles, the day/night switch (`light` in the URL),
  labels for neighbourhoods and the venue at 24px or more. Everything also works by
  touch.
- **Verify:** unit tests for the preset maths; one `check:visual` per preset, each
  including "the on-screen text is readable from the back of a room" (score, at least
  "acceptable").

### T8. Integration and review plan (after all)

- **Owns:** integration fixes, `src/constants.ts` tuning, `README.md`,
  `plan/review-plan.json`, `checks/stage.json`.
- **Build:** wire T4 and T5 data into T6's live `CityState`; tune depth and opacity
  so buildings, ground and subway read clearly together; check memory and frame time
  with everything on; write the morning test plan (`plan/review-plan.json`, schema in
  the `human-review` skill) with steps that each open a URL hash. The overlay reads
  it with `--plan <absolute path>`.
- **Verify:** the full suite: every ticket's checks, plus `checks/stage.json` on the
  Venue view at night: "trains are visible under the venue", "the panel answers a
  route question".

### T9. Review in the app

- **Owns:** `scripts/review-e2e.ts`, `checks/review-note.json`, the "Review it"
  section of `README.md` (T8 owns the rest of the README).
- **Build:** one command that proves a person can review the app with the reviewer
  overlay (`/human-review`). It starts its own throwaway mesh (its own Redis and
  `AGENT_MESH_HOME`, never the run's mesh), registers a reviewer agent, starts the
  overlay server for the app's origin, a dev server with `NYC_LIVE_OVERLAY`, and a
  headless Chrome that accepts tab capture (`--auto-accept-this-tab-capture`, as in
  `reviewer-overlay/e2e/run.sh`). It opens a view with `sel=bin:1007945`, opens the
  Reviewer panel, drops a pin on the venue, sends a note, then reads the reviewer's
  inbox and stops everything it started.
- **Verify:** the note arrives with the comment, a page URL whose hash parses to the
  view that was open, and a screenshot. `check:visual` on that screenshot:
  "a 3D map scene is visible, not a blank or black canvas", "a numbered pin marker
  is drawn on the image". The command exits 0 only when all of that holds.
- **Done:** reviewing the app needs only the two commands in "Review it", and they
  also work through a proxy (a second `--origin` plus `NYC_LIVE_ALLOWED_HOSTS`).

### T10. The reviewer overlay looks like the in-app reviewer

- **Owns:** `reviewer-overlay/src/client/` (look only), `reviewer-overlay/test/`
  additions, the screenshots in `reviewer-overlay/README.md`.
- **Build:** restyle the overlay's launcher button, panel, pins and drawing to match
  the design reference screenshots named in your spawn prompt (they are not in the
  repository). The launcher carries the animated agent-mesh mark, inlined from
  `agent-mesh/dashboard/public/agentmesh-mark.svg`. Copy the design only, never code.
  Keep the behaviour, the HTTP API, the message contract, and every label and
  selector that `reviewer-overlay/e2e/run.sh` and T9 use.
- **Verify:** `pnpm --dir reviewer-overlay typecheck`, `test` and `build` pass, and
  `bash reviewer-overlay/e2e/run.sh` passes with its script unchanged. Screenshot the
  closed launcher and the open panel over nyc-live, and check them with the Decisions
  API against the reference, sending both images in one request: "the launcher shows
  the mesh mark", "the panel's layout and colours match the reference" (score, at
  least "close").

## Out of scope

Accounts, saved data on a server, deployment, and anything outside `examples/nyc-live/`
(T10 alone works in `reviewer-overlay/`).
