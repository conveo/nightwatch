import { randomUUID } from "node:crypto"
import { z } from "zod"
import { endpointSchema, managedTransportSchema, ownerSchema, selectDelivery } from "./managed-delivery.js"
import type { ManagedScheduler } from "./managed-scheduler.js"
import type { DeliverTransport } from "./delivery.js"
import { meshPrefix } from "./keys.js"
import { lookupAgent, registerAgent } from "./hub.js"
import { setLocalAgent, type LocalAgentDef } from "./local-store.js"
import { agentIdSchema } from "./types.js"
import type { MeshRedis } from "./redis.js"
import { log } from "./log.js"

// Re-registration replaces this object and re-arms the liveness transition.
export type LocalAgent = { def: LocalAgentDef; deliver: DeliverTransport; dead: boolean }

export function ownerKey(id: string): string {
  return `${meshPrefix()}:owner:${id}`
}

type Argument = {
  raw: unknown
  local: Map<string, LocalAgent>
  redis: MeshRedis
  scheduler: ManagedScheduler
  host: string
}

// The daemon serializes registrations and reserves this actor against scheduler
// starts throughout verification, broker ownership CAS, and local persistence.
export async function bindManagedActor({ raw, local, redis, scheduler, host }: Argument): Promise<LocalAgentDef> {
  const input = z
    .object({
      id: agentIdSchema,
      role: z.string().min(1),
      meta: z.record(z.string(), z.unknown()).default({}),
      owner: ownerSchema.nullable(),
      endpoint: endpointSchema.nullable(),
      monitor: z.boolean(),
      dedicated: z.boolean(),
      hints: z.record(z.string(), z.string()),
      expectedGeneration: z.string().uuid().nullable(),
      tickMs: z.number().int().min(1000).nullable(),
    })
    .parse(raw)
  const previous = local.get(input.id)
  const claim = await redis.get(ownerKey(input.id))
  if (scheduler.busy(input.id)) throw new Error("delivery in flight; cannot replace owner")
  if (["sending", "ambiguous"].includes(scheduler.wakeups.state(input.id)?.batch?.outcome ?? ""))
    throw new Error("ambiguous submission: inspect and resolve the pending batch before rebinding")
  if (previous?.deliver.type === "managed") {
    if (input.expectedGeneration !== previous.deliver.generation || claim !== input.expectedGeneration)
      throw new Error("binding exists; use rebind with its current generation")
  } else if (input.expectedGeneration != null || claim != null) throw new Error("actor owned elsewhere or retired; choose a new actor id")
  // Never adopt a legacy watch implicitly; its stdout may already be queued in
  // the harness. Stop it first and use a new actor id for that transition.
  if (previous != null && previous.deliver.type !== "managed") throw new Error("legacy actor exists; preserve it and bind a new actor id")
  const existing = await lookupAgent(redis, input.id)
  if (existing != null && previous == null) throw new Error("actor registered on another host; use a new actor id for deliberate transfer")
  const selection = await selectDelivery({
    endpoint: input.endpoint,
    env: input.hints,
    monitor: input.monitor,
    owner: input.owner,
    dedicated: input.dedicated,
  })
  if (selection.type === "adapter") {
    for (const [otherId, other] of local) {
      if (
        otherId !== input.id &&
        other.deliver.type === "managed" &&
        other.deliver.selection.type === "adapter" &&
        JSON.stringify(other.deliver.selection.endpoint) === JSON.stringify(selection.endpoint)
      )
        throw new Error("endpoint already bound to another actor")
    }
  }
  if (input.tickMs != null && selection.type !== "adapter") throw new Error("daemon ticks require a verified adapter binding")
  if (previous?.deliver.type === "managed" && previous.deliver.selection.type === "monitor" && selection.type !== "monitor")
    throw new Error("stop legacy Monitor and use a new actor id; queued harness events cannot be fenced")
  const deliver = managedTransportSchema.parse({
    type: "managed",
    generation: randomUUID(),
    owner: input.owner,
    selection,
    tickMs: input.tickMs,
  })
  const acquired = await redis.eval(
    'local old = redis.call("GET", KEYS[1]); if (ARGV[1] == "" and not old) or old == ARGV[1] then redis.call("SET", KEYS[1], ARGV[2]); return 1 end return 0',
    { keys: [ownerKey(input.id)], arguments: [input.expectedGeneration ?? "", deliver.generation] },
  )
  if (acquired !== 1) throw new Error("owner changed during verification")
  const def: LocalAgentDef = {
    id: input.id,
    role: input.role,
    meta: { ...input.meta, ...(input.owner == null ? {} : { runtime: input.owner.runtime, session: input.owner.session }) },
    deliver,
  }
  // Claim remains reserved if persistence fails; another host must not steal
  // it after an ambiguous write. Operator recovery is explicit, not TTL based.
  scheduler.wakeups.bind({ id: input.id, generation: deliver.generation, now: Date.now(), tickMs: deliver.tickMs })
  setLocalAgent(def)
  local.set(def.id, { def, deliver, dead: false })
  await registerAgent(redis, { id: def.id, role: def.role, host, meta: def.meta })
  // Direct broker history is retained on a managed bind, including mail that
  // arrives while endpoint verification is in flight.
  log.info("bound local actor", { id: def.id, generation: deliver.generation, selection: selection.type, reason: selection.reason })
  return def
}
