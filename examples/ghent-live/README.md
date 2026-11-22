# ghent-live: Ghent's historic centre, live, in 3D

An example app for nightwatch to build overnight: the centre of Ghent in three.js,
by night. The buildings at their real heights, the Leie and the Schelde, the
circulation plan's sectors and its car-free core, the Lichtplan lighting the towers,
parking garages and shared bikes with live availability, and an "ask Ghent" panel
that answers typed questions about the city's current state.

This folder starts as a **base**: the app shell, the view state in the URL, one empty
file per layer, and the checks every worker uses to verify its own ticket. The plan
the fleet builds from is [plan/PLAN.md](plan/PLAN.md). It has the same shape as
[nyc-live](../nyc-live/), the example built for an earlier run.

## Run it

You need Node 22.18 or later and pnpm 12. It has its own pnpm workspace, so it does
not touch the mesh's dependencies.

```bash
pnpm --dir examples/ghent-live install
pnpm --dir examples/ghent-live dev          # http://127.0.0.1:5280
```

Drag to pan, right-drag to rotate, scroll to zoom. The URL hash always describes the
current view, for example:

```
#cam=-250,420,620&tgt=0,0,0&sel=garage:vrijdagmarkt&mode=recorded&t=2026-11-25T18:30:00Z&layers=buildings,parking&light=night&ask=park:gravensteen
```

`cam` and `tgt` are the camera and its target in metres from the Belfry (x east,
y up, z south). `sel` is the selection (the formats are in the plan's "Contracts").
`mode` is `fixture` (small committed samples), `recorded` (a saved snapshot, at time
`t`) or `live`. `layers` limits what is drawn, `light` is `day` or `night`, and `ask`
is the question in the "ask Ghent" panel. Because the hash is the whole view, a
[reviewer-overlay](../../reviewer-overlay/) note, which carries the page URL, lets an
agent open exactly what the reviewer saw.

## Check it

| Command | What it does |
| --- | --- |
| `pnpm test` | Unit tests (`node --test`). No network, no key. |
| `pnpm typecheck` | TypeScript. |
| `pnpm shot [--hash '#…'] [--out file.png]` | Opens the dev server in headless Chrome, waits until the app reports ready, saves a screenshot. |
| `pnpm check:visual <png> <checks.json>` | Asks the OpenAI Decisions API whether the screenshot shows what the checks describe, and exits 0 only if every check clears its bar. |
| `pnpm browser` | Starts one shared headless Chrome. Export the `GHENT_LIVE_CDP` it prints so `pnpm shot` opens a tab there instead of a Chrome of its own. |

A check file is a context sentence plus checks. Each check is a question with a bar:
a `predicate` needs a probability (`"min": 0.8`), a `choice` an expected option, a
`score` a minimum level. See [checks/origin.json](checks/origin.json):

```bash
pnpm shot --out shots/origin.png
pnpm check:visual shots/origin.png checks/origin.json
# PASS  origin_marker            p=100% (needs 80%)
# PASS  title                    p=100% (needs 80%)
# PASS  stage_readability        acceptable at 68% (needs acceptable or better)
```

`check:visual` needs `OPENAI_API_KEY` in the environment (or `--env-file <path>`). With
`--record` it also saves the answers under `test/recordings/`; with `--replay` it reads
them back and needs no key. That is how [test/check-visual.test.ts](test/check-visual.test.ts)
runs a real screenshot's real answers in CI. A recording is stored under a hash of the
whole request, screenshot included, so a changed screenshot needs a new recording. A
visual check costs about 2,000 input tokens, a fraction of a cent.

The key is read on the server side only: by `check:visual` and, once the "ask Ghent"
panel exists, by the dev server's `/api/ask`. It never reaches the browser.

## Review it

The [reviewer overlay](../../reviewer-overlay/) lets a person pin notes, with a
screenshot, on the running app; each note reaches an agent's mesh inbox. Two
commands, from the repository root: start the overlay server with every origin the
app is opened from and the mesh id of the agent that reads the notes (the one
running `/human-review`; the overlay publishes with the `agent-mesh` CLI on your
`PATH`), then point the dev server at it:

```bash
pnpm overlay --port 4858 --origin http://127.0.0.1:5280 --target <reviewer agent id> \
  --plan "$PWD/examples/ghent-live/plan/review-plan.json"
GHENT_LIVE_OVERLAY=http://127.0.0.1:4858 pnpm --dir examples/ghent-live dev
```

Open http://127.0.0.1:5280, click **Reviewer**, then **Add comment**, and share the
tab when the browser asks; click the spot, write the note and send it. The dev
server adds the overlay's script to the page and forwards the script and
`/api/review` on the app's own origin, so the browser only talks to the app. Each
note carries the page URL, whose hash is the exact view, and a PNG of the tab with
the numbered pin drawn on it. The overlay never enters a production build.

Through a proxy such as `tailscale serve`, add the proxy's origin with a second
`--origin`, and its host name to `GHENT_LIVE_ALLOWED_HOSTS`:

```bash
pnpm overlay --port 4858 --origin http://127.0.0.1:5280 --origin https://<machine>.<tailnet>.ts.net \
  --target <reviewer agent id> --plan "$PWD/examples/ghent-live/plan/review-plan.json"
GHENT_LIVE_OVERLAY=http://127.0.0.1:4858 GHENT_LIVE_ALLOWED_HOSTS=<machine>.<tailnet>.ts.net \
  pnpm --dir examples/ghent-live dev
```

The proxy must serve https: a browser shares a tab only from a secure context
(`https://`, or `localhost` and `127.0.0.1`).

[scripts/review-e2e.ts](scripts/review-e2e.ts) proves all of this end to end. With a
throwaway mesh of its own (a Redis container and a daemon, never a mesh already
running), the overlay server, a dev server and a short-lived headless Chrome, it
reviews the default view at night with the Belfry selected, once on the app's own
origin and once through a proxy's host name: it drops a pin on the red ring, sends a
note, and checks that the note reaches the reviewer's inbox with the comment, a URL
whose hash is the view, and a screenshot of the scene with the pin. Then
`check:visual` runs [checks/review-note.json](checks/review-note.json) on that
screenshot. It needs Docker, the repository's root dependencies
(`pnpm install --frozen-lockfile` at the root) and a key for `check:visual`:

```bash
node scripts/review-e2e.ts --env-file <file with OPENAI_API_KEY>    # in examples/ghent-live
CHROME_FLAGS=--no-sandbox node scripts/review-e2e.ts --env-file <file>    # where Chrome's sandbox cannot start
```

## Settings

| Variable | Default | Use |
| --- | --- | --- |
| `GHENT_LIVE_PORT` | `5280` | Dev server port (preview uses the next one). Give each worker its own. |
| `GHENT_LIVE_CDP` | none | A shared Chrome's DevTools URL, from `pnpm browser`. |
| `GHENT_LIVE_CDP_PORT` | `9343` | Port for `pnpm browser`. |
| `GHENT_LIVE_ALLOWED_HOSTS` | none | Extra `Host` names the dev server accepts, comma separated, for a proxy such as `tailscale serve`. The server listens on 127.0.0.1 only. |
| `CHROME` | auto | A Chrome or Chromium binary, if the search does not find one. |
| `OPENAI_API_KEY` | none | For `check:visual` and `/api/ask`. |
| `GHENT_LIVE_OVERLAY` | none | The reviewer overlay's server (`http://127.0.0.1:4858`). The dev server then adds the overlay to the page and forwards it on the app's own origin. |

## Data

The city data is downloaded by scripts, never committed; only small fixtures are. No
source needs an account or a key. All of it is published under the Flemish
[Modellicentie Gratis Hergebruik](https://data.vlaanderen.be/doc/licentie/modellicentie-gratis-hergebruik/v1.0),
which asks for attribution (the footer of the app):

- **Buildings, heights, water and roads:** Digitaal Vlaanderen's GRB WFS
  (`geo.api.vlaanderen.be/GRB/wfs`: building footprints, water surfaces, road
  surfaces) and the DHMV II elevation model (`geo.api.vlaanderen.be/DHMV/wcs`:
  surface minus terrain gives a building's height).
- **City data:** [Stad Gent open data](https://data.stad.gent): the circulation plan's
  sectors and "knips", the Lichtplan's points of interest and walk, parking garage
  occupancy, and shared-bike availability (Donkey Republic, Bolt, Blue-bike).

The app serves every feed from its own server routes, never straight from the
browser. Neither Digitaal Vlaanderen nor Stad Gent endorses this example.

## Licence

The code is MIT, like the rest of the repository. The data keeps its own terms.
