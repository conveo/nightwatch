// Redis key schema for the agent hub. All keys live under a single configurable
// prefix so hub traffic is namespaced (and a whole environment can be wiped with
// one `DEL mesh:*` without touching app data).

export function meshPrefix(): string {
  return process.env.AGENT_MESH_PREFIX ?? "mesh"
}

export function agentsKey(): string {
  return `${meshPrefix()}:agents`
}

export function inboxKey(agentId: string): string {
  return `${meshPrefix()}:inbox:${agentId}`
}

export function broadcastKey(): string {
  return `${meshPrefix()}:broadcast`
}

// Per-host fan-out stream. A message addressed to `host:<hostname>` lands here,
// and ONLY the daemon on that host tails it (delivering to every local agent) —
// the host-scoped counterpart to the mesh-wide broadcast. Hostnames are charset-
// validated (`[A-Za-z0-9._-]`) at the publish boundary, so they're safe in a key.
export function hostBroadcastKey(hostname: string): string {
  return `${meshPrefix()}:host:${hostname}:broadcast`
}
