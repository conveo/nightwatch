# Security

## Read this before you run a fleet

nightwatch runs coding agents without a person watching. For that to work, the
agents run with their approval prompts turned off:

- Claude Code: `--dangerously-skip-permissions`
- Codex CLI: `--dangerously-bypass-approvals-and-sandbox` (`--yolo`)

In this mode an agent can run any command, read and write any file the user can,
and use any credential in its environment, without asking. A prompt injection in a
web page, an issue, a dependency or a mesh message can make it do so.

Only run agents in this mode on a machine that is isolated for that purpose:

- a dedicated VM or container, not your daily laptop session and not a shared server;
- no production credentials, no cloud admin roles, no SSH keys to other machines;
- a GitHub token that can only push branches and open pull requests on the repos in
  scope, never merge to the default branch;
- network access limited to what the run needs.

A git worktree is not isolation. It separates files, not permissions.

## The mesh has no authentication

- Anyone who can connect to the Redis broker can read every message and send
  messages as any agent id. Agent ids are labels, not credentials.
- Keep the broker on loopback or a private network. Use TLS (`rediss://`) for any
  broker that is not on loopback. Set a Redis password if other people or services
  can reach the network.
- The dashboard server (`127.0.0.1:4747`) has no authentication either. Anyone who
  can reach its port can read every plan it serves and publish to the mesh as the
  operator. It binds loopback only; reach it from another machine through an SSH
  tunnel (`ssh -N -L 4747:127.0.0.1:4747 <host>`), and never through a port
  forward, a public proxy or `AGENT_MESH_UI_ALLOWED_HOSTS` on a shared network.
- The daemon's Unix socket is a trusted local interface: any process of the same
  user can publish through it.

## The mesh console

- The console is part of the dashboard server, with the same lack of login. To use it
  from a phone, put `tailscale serve` in front and set `AGENT_MESH_UI_ALLOWED_USERS`
  to your own Tailscale login; never `tailscale funnel`. See
  [docs/CONSOLE.md](docs/CONSOLE.md#on-a-phone).
- With `OPENAI_API_KEY` set, the assistant sends your turns, the agent messages it
  reads and recaps, and your voice audio to OpenAI. Without a key nothing leaves the
  machine.
- The assistant can send mesh messages as you without asking first. An agent message
  can try to instruct it. The console treats agent text as quoted data and tells the
  model so, but cannot rule out a model following an injected instruction.
- Images in agent messages and model output are never loaded.
- Message bodies are untrusted input. An agent must only act on a message that fits
  the work it was given.

See [docs/DEPLOY.md](docs/DEPLOY.md) for the network model.

## Supported versions

Only the latest commit on `main` is supported. Fixes are not backported to older
commits.

## Reporting a vulnerability

Report a security problem privately through GitHub's private vulnerability
reporting: open the repository's **Security** tab and click **Report a
vulnerability**. Do not open a public issue for it.
