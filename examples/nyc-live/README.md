# nyc-live: lower Manhattan, live, in 3D

An example app that a nightwatch run built overnight: lower Manhattan's buildings in
three.js, the subway lines below the streets, trains moving in real time, Citi Bike
docks, and an "ask the city" panel that answers typed questions about the live state.

It started as a **base** (the app shell, the view state in the URL, one empty file
per layer, and the checks every worker uses to verify its own ticket), and the fleet
filled it in ticket by ticket from [plan/PLAN.md](plan/PLAN.md). The morning test
plan, one view per feature, is [plan/review-plan.json](plan/review-plan.json).

## Run it

You need Node 22.18 or later and pnpm 12. It has its own pnpm workspace, so it does
not touch the mesh's dependencies.

```bash
pnpm --dir examples/nyc-live install
pnpm --dir examples/nyc-live dev          # http://127.0.0.1:5180
```

Drag to pan, right-drag to rotate, scroll to zoom (one finger pans and two rotate and
zoom on a touch screen), or use the toolbar's camera presets, layer toggles and
day/night switch. The URL hash always describes the current view, also while the
camera still glides after a drag, for example:

```
#cam=320,420,620&tgt=0,0,0&sel=bin:1007945&mode=recorded&t=2026-10-18T23:02:17Z&layers=buildings,subway&light=night&ask=route:brooklyn-bridge
```

`cam` and `tgt` are the camera and its target in metres from 598 Broadway (x east,
y up, z south). `sel` is what is selected: a building (`bin:<BIN>`), a subway line
(`route:N`) or a station (`stop:R22`). `mode` is `fixture` (small committed samples),
`recorded` (a saved feed, at time `t`) or `live`; a link to another mode or time
reloads the page. `layers` limits what is drawn, `light` is `day` or `night`, and
`ask` is the question in the "ask the city" panel. Because the hash is the whole
view, a [reviewer-overlay](../../reviewer-overlay/) note, which carries the page URL,
lets an agent open exactly what the reviewer saw.

Fixture mode works offline from `public/fixtures/`. Recorded and live mode draw the
whole area once its data is downloaded into `data/` (not committed); until then they
draw the fixtures and the status line says so:

```bash
node scripts/fetch-buildings.ts    # data/buildings.json, NYC Open Data
node scripts/fetch-subway.ts       # data/subway.json, the MTA's static GTFS
node scripts/record-feeds.ts --every 30 --minutes 60   # data/trains/, a recording for recorded mode
```

The ground, the Citi Bike docks outside live mode and a short recording of the
trains (Oct 18, 7:02 PM ET) are committed, so recorded mode at
`t=2026-10-18T23:02:17Z` works without downloading anything. Live mode needs the dev
server to reach the MTA's and Citi Bike's feeds; the browser only talks to the dev
server.

The subway is drawn twice: as lit tubes 12 m below the street, and again
see-through, so the lines read through the ground and, fainter, through the
buildings, and the trains clearly through both. The see-through copy fades out as
the camera comes down to street level.

## Check it

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests (`node --test`). No network, no key. |
| `pnpm typecheck` | TypeScript. |
| `pnpm shot [--hash '#…'] [--out file.png]` | Opens the dev server in headless Chrome, waits until the app reports ready, saves a screenshot. |
| `pnpm check:visual <png> <checks.json>` | Asks the OpenAI Decisions API whether the screenshot shows what the checks describe, and exits 0 only if every check clears its bar. |
| `pnpm browser` | Starts one shared headless Chrome. Export the `NYC_LIVE_CDP` it prints so `pnpm shot` opens a tab there instead of a Chrome of its own. |

A check file is a context sentence plus checks. Each check is a question with a bar:
a `predicate` needs a probability (`"min": 0.8`), a `choice` an expected option, a
`score` a minimum level. See [checks/venue.json](checks/venue.json):

```bash
pnpm shot --out shots/venue.png
pnpm check:visual shots/venue.png checks/venue.json
# PASS  venue_marker             p=100% (needs 80%)
# PASS  title                    p=100% (needs 80%)
# PASS  stage_readability        acceptable at 75% (needs acceptable or better)
```

`check:visual` needs `OPENAI_API_KEY` in the environment (or `--env-file <path>`). With
`--record` it also saves the answers under `test/recordings/`; with `--replay` it reads
them back and needs no key. That is how [test/check-visual.test.ts](test/check-visual.test.ts)
runs a real screenshot's real answers in CI. A visual check costs about 2,000 input
tokens, a fraction of a cent.

The key is read on the server side only: by `check:visual` and by the dev server's
`/api/ask`. It never reaches the browser.

## Ask the city

The panel at the top right turns a question (the fastest way from the venue to a
place, whether a line runs normally, or a free yes/no question) and the city's
current state into one Decisions API request, and shows the answer with its
probability; a route answer also highlights its line in the scene. The state comes
from the view's mode, and the panel says which:

- **fixture**: a hand-made weekday evening ([server/city-state.ts](server/city-state.ts)).
- **recorded**: the trains in the saved feed at `t`, and the committed Citi Bike docks.
- **live**: the MTA's realtime feeds and Citi Bike's GBFS feed now, through the same
  caches as the layers' own routes.

Line service is worked out from the trains: the minutes between trains at each line's
busiest platform over the next hour, "reduced" past 15 minutes, "suspended" when no
train of the line is in the feed. `GET /api/city?mode=live` (or
`?mode=recorded&t=…`) shows the state a question is answered from.

## How it performs

With everything on, the whole area (13,000 buildings, 20 subway lines, about 30
trains, 235 Citi Bike docks) takes 82 to 88 draw calls and about 0.55 million
triangles, loads in about 2.5 s, and holds about 14 MB of JavaScript heap once
loaded. `window.__nycLive.stats()` reports the draw calls, triangles and GPU objects
of the last frame.

## Review it

The [reviewer overlay](../../reviewer-overlay/) lets a person pin notes, with a
screenshot, on the running app; each note reaches an agent's mesh inbox. With the
agent-mesh daemon running, it takes two commands from the repository root: start the
overlay server with every origin the app is opened from, then point the dev server
at it.

```bash
pnpm overlay --origin http://127.0.0.1:5180 --target <reviewer agent id> \
  --plan "$PWD/examples/nyc-live/plan/review-plan.json"
NYC_LIVE_OVERLAY=http://127.0.0.1:4848 pnpm --dir examples/nyc-live dev
```

Open the app, click **Reviewer** (bottom right), then **Add comment**, and allow
sharing this tab. Click the scene to drop a pin, write a note and click **Send**.
The agent reads the note with `agent-mesh inbox` (or `agent-mesh watch`): the
comment, the pin, a screenshot of the tab with the pin drawn on it, and the page
URL, whose hash is the exact view.

The dev server adds the overlay's script to the page and forwards the script and
`/api/review` on the app's own origin, so the browser only talks to the app. The
overlay never enters a production build. Through a proxy such as `tailscale serve`,
add the proxy's origin with another `--origin`, and its host to
`NYC_LIVE_ALLOWED_HOSTS`:

```bash
pnpm overlay --origin http://127.0.0.1:5180 --origin https://<proxy host> \
  --target <reviewer agent id> --plan "$PWD/examples/nyc-live/plan/review-plan.json"
NYC_LIVE_OVERLAY=http://127.0.0.1:4848 NYC_LIVE_ALLOWED_HOSTS=<proxy host> \
  pnpm --dir examples/nyc-live dev
```

One command proves that all of this works. `scripts/review-e2e.ts` runs both
commands on free ports against a throwaway mesh (its own Redis container and
`AGENT_MESH_HOME`, never the mesh you work on) and opens the venue with
`sel=bin:1007945` in a headless Chrome that accepts tab capture. It drops a pin on
the venue, sends a note and reads the reviewer's inbox, then checks the note: the
comment, a page URL whose hash is the view that was open, and a screenshot that
passes [checks/review-note.json](checks/review-note.json). It stops everything it
started and exits 0 only when all of that holds. It needs Docker, Chrome, and an
OpenAI key for the visual check.

```bash
node scripts/review-e2e.ts --env-file <file with OPENAI_API_KEY>   # from examples/nyc-live
node scripts/review-e2e.ts --via-proxy --env-file <file>           # the same, through a proxy
```

`--via-proxy` opens the app on a second host name through a local proxy that keeps
the browser's `Host` header, as `tailscale serve` does. `--out` sets where the
received screenshot is saved (`shots/review-note.png`), `--record` saves the visual
check's answers for [test/review-e2e.test.ts](test/review-e2e.test.ts), and `--keep`
keeps the logs of everything it started.

## Settings

| Variable | Default | Use |
| --- | --- | --- |
| `NYC_LIVE_PORT` | `5180` | Dev server port (preview uses the next one). Give each worker its own. |
| `NYC_LIVE_CDP` | none | A shared Chrome's DevTools URL, from `pnpm browser`. |
| `NYC_LIVE_CDP_PORT` | `9333` | Port for `pnpm browser`. |
| `NYC_LIVE_ALLOWED_HOSTS` | none | Extra `Host` names the dev server accepts, comma separated, for a proxy such as `tailscale serve`. The server listens on 127.0.0.1 only. |
| `CHROME` | auto | A Chrome or Chromium binary, if the search does not find one. |
| `OPENAI_API_KEY` | none | For `check:visual` and `/api/ask`. |
| `NYC_LIVE_OVERLAY` | none | The reviewer overlay's server (`http://127.0.0.1:4848`). The dev server then adds the overlay to the page and forwards it on the app's own origin. |

## Data

The city data is downloaded by scripts, not committed. Each source has its own terms:

- **Buildings:** [NYC Open Data, BUILDING](https://data.cityofnewyork.us/City-Government/BUILDING/5zhs-2jue)
  (footprints and roof heights).
- **Subway:** MTA static GTFS and GTFS-realtime feeds, under the
  [MTA's terms for data feeds](https://www.mta.info/developers/terms-and-conditions).
  Among them: the app serves the feeds from its own server, never straight from MTA;
  it does not suggest MTA endorsement; and when realtime data lags by more than a
  minute it tells the viewer it may not be real time.
- **Bikes:** the Citi Bike GBFS feed, under the
  [NYCBS Data Use Policy](https://citibikenyc.com/system-data).

None of these organisations endorses this example.

## Licence

The code is MIT, like the rest of the repository. The data keeps its own terms.
