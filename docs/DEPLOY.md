# Deploying agent-mesh

agent-mesh has two moving parts:

1. a **shared Redis broker** every host can reach, and
2. a **per-host daemon**, which each agent bootstraps itself.

There is no central hub service to run and no app-level auth — **the broker's
reachability is the trust boundary**, so put the broker somewhere only your hosts
can reach it (see Security below).

## Network model

Agents typically run on a mix of hosts:

- **your laptop(s)** — running agents locally,
- **one or more remote boxes** — a beefy machine per developer, many worktrees/
  agents each.

They all need to reach **one** Redis. Any of these works:

- **Single machine:** a local Redis (`docker compose up -d` at the repo root gives
  `redis://localhost:6379`). Nothing else is needed.
- **Multiple hosts, same private network:** a Redis in that network, reachable by
  every host directly.
- **Multiple hosts, mixed networks (e.g. laptops + cloud boxes):** a Redis reachable
  from all of them — a managed cloud Redis with a firewall/security-group allowing
  your hosts, or an in-network Redis exposed to laptops over a VPN. Use a TLS
  endpoint (`rediss://`) and restrict who can connect at the network layer.

The daemon reads the broker URL from **`AGENT_MESH_REDIS_URL`**. How that value
reaches each host is deployment-specific — export it in a shell profile, read it
from a secrets manager, or inject it via your provisioning.

`start-local.sh` and the supervisor installer resolve it with `resolve_mesh_url`
(`lib/mesh-bootstrap.sh`). An existing `AGENT_MESH_REDIS_URL` always wins and
nothing else runs. Otherwise, when **`AGENT_MESH_SITE_HOOK`** names a file, that
file is sourced, and if it defines `mesh_site_resolve_redis_url`, the URL that
function prints is exported. Use a hook for a site-specific lookup, such as a
secrets manager. Without the variable or a hook, the scripts stop and say so:

```bash
# my-site-hook.sh
mesh_site_resolve_redis_url() {
  my-secrets-cli get agent-mesh/redis-url   # prints rediss://…
}
```

```bash
AGENT_MESH_SITE_HOOK=/path/to/my-site-hook.sh ./agent-mesh/start-local.sh
```

## The daemon — self-bootstrapped by the agent

There is no systemd unit or boot-script requirement. On first use an agent:

1. installs an `agent-mesh` CLI wrapper on `PATH` (`install_cli_wrapper`), then
2. starts the daemon idempotently if `agent-mesh health` fails and
   `AGENT_MESH_REDIS_URL` is set:
   ```bash
   nohup pnpm --dir <repo>/agent-mesh daemon &
   ```

The daemon binds one shared `$HOME/.agent-mesh/daemon.sock`, so the first agent on
a host starts it and every other agent reuses it — exactly one daemon per host. To
keep it alive and current across days/reboots without a human, install the
supervisor (see [SUPERVISOR.md](SUPERVISOR.md)).

## The dashboard

`pnpm ui` serves the dashboard on `127.0.0.1:${AGENT_MESH_UI_PORT:-4747}`. It
always binds loopback and has **no authentication**, so it has no option to bind a
network address. To use it on a remote host, tunnel to it from the laptop:

```bash
ssh -N -L 4747:127.0.0.1:4747 <remote-host>   # then open http://127.0.0.1:4747
```

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_MESH_UI_PORT` | `4747` | The port on 127.0.0.1. |
| `AGENT_MESH_PLANS_ROOT` | the checkout the dashboard runs from | The base for relative `plan=` paths in the Plans tab. |
| `AGENT_MESH_PLANS_ROOTS` | none | More directories the Plans tab may read from, `:`-separated. By default a plan must be inside the dashboard's checkout or one of that repository's git worktrees. Symlinks are resolved before the check. |
| `AGENT_MESH_UI_ALLOWED_HOSTS` | none | More `Host` header names to accept, comma-separated, for a reverse proxy that forwards its own name. Loopback names are always accepted; any other name is refused, which blocks DNS rebinding. The same list applies to `X-Forwarded-Host`. A proxy does not add authentication. |
| `AGENT_MESH_UI_ALLOWED_USERS` | none | Tailscale logins, comma-separated. When set, a request that came through a proxy must carry one of them in `Tailscale-User-Login`, which `tailscale serve` sets and `tailscale funnel` does not. |

The API refuses requests a browser marks as cross-site, and a state-changing
request from a browser must be JSON from the dashboard's own origin. Behind a proxy
that rewrites `Host` to the loopback address, the page's origin is accepted from
`X-Forwarded-Host` only when that name is in `AGENT_MESH_UI_ALLOWED_HOSTS`. Request
bodies over 10 MB are refused.

To use the console on a phone, see [CONSOLE.md](CONSOLE.md#on-a-phone).

## Inspecting by hand

```bash
redis-cli -u "$AGENT_MESH_REDIS_URL" [--tls] HGETALL mesh:agents             # roster
redis-cli -u "$AGENT_MESH_REDIS_URL" [--tls] XRANGE mesh:inbox:<agent-id> - +  # a mailbox
redis-cli -u "$AGENT_MESH_REDIS_URL" [--tls] XRANGE mesh:broadcast - +       # broadcast log
```

(All keys live under a single configurable prefix — `AGENT_MESH_PREFIX`, default
`mesh` — so a whole environment can be wiped with one `DEL mesh:*` without touching
other data in the same Redis.)

## Security

- **Transport:** use TLS to the broker (`rediss://`) for anything but loopback, and
  a private link (VPN / private network) for the laptop path.
- **Access boundary:** the broker's network reachability (firewall / security group
  / VPN ACL). There is **no Redis AUTH token or per-agent auth by default** — this is
  acceptable for a trusted coordination broker on a private network, and NOT
  acceptable on a broker exposed to the public internet.
- **Agent ids** are charset-validated (`[A-Za-z0-9._-]`) at the daemon boundary, so a
  hostile id can't traverse paths or inject keys.
- **Hardening follow-ups** if you need them: enable a Redis AUTH token (put the
  password in the URL) and add per-agent identity on the local socket.
