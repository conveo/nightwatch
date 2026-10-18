# nyc-live: lower Manhattan, live, in 3D

An example app for nightwatch to build overnight: lower Manhattan's buildings in
three.js, the subway lines below the streets, trains moving in real time, Citi Bike
docks, and an "ask the city" panel that answers typed questions about the live state.

This folder starts as a **base**: the app shell, the view state in the URL, one empty
file per layer, and the checks every worker uses to verify its own ticket. The plan
the fleet builds from is [plan/PLAN.md](plan/PLAN.md).

## Run it

You need Node 22.18 or later and pnpm 12. It has its own pnpm workspace, so it does
not touch the mesh's dependencies.

```bash
pnpm --dir examples/nyc-live install
pnpm --dir examples/nyc-live dev          # http://127.0.0.1:5180
```

Drag to pan, right-drag to rotate, scroll to zoom. The URL hash always describes the
current view, for example:

```
#cam=320,420,620&tgt=0,0,0&sel=bin:1007945&mode=recorded&t=2026-10-21T23:10:00Z&layers=buildings,subway
```

`cam` and `tgt` are the camera and its target in metres from 598 Broadway (x east,
y up, z south). `mode` is `fixture` (small committed samples), `recorded` (a saved
feed, at time `t`) or `live`. `layers` limits what is drawn. Because the hash is the
whole view, a [reviewer-overlay](../../reviewer-overlay/) note, which carries the
page URL, lets an agent open exactly what the reviewer saw.

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

The key is read on the server side only: by `check:visual` and, once the "ask the
city" panel exists, by the dev server's `/api/ask`. It never reaches the browser.

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
