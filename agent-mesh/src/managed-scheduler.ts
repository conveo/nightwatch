import { Wakeups, type Batch } from "./wakeups.js"
import { submitNotification, runCommand, verifyEndpoint, type ManagedTransport } from "./managed-delivery.js"
import { log } from "./log.js"

export class ManagedScheduler {
  readonly wakeups = new Wakeups()
  private active = new Set<string>()
  constructor(private dependencies: { verify: typeof verifyEndpoint; run: typeof runCommand }) {}
  busy(id: string) {
    return this.active.has(id)
  }

  // The caller ticks all actors; at most four subprocess pipelines run at once,
  // and one actor cannot overlap itself. No model-completion wait is used.
  schedule({ id, transport, owns }: { id: string; transport: ManagedTransport; owns: () => Promise<boolean> }): void {
    if (transport.selection.type !== "adapter" || transport.owner == null || this.active.has(id)) return
    if (transport.tickMs != null) this.wakeups.tick({ id, generation: transport.generation, now: Date.now(), tickMs: transport.tickMs })
    if (this.active.size >= 4) return
    const batch = this.wakeups.claim({ id, generation: transport.generation, now: Date.now() })
    if (batch == null || batch.outcome !== "pending" || batch.nextAttempt > Date.now()) return
    this.active.add(id)
    this.attempt({ id, transport, owns, batch })
      .catch((error) => log.warn("managed delivery failed; pending state retained", { id, error: String(error) }))
      .finally(() => this.active.delete(id))
  }

  private async attempt({
    id,
    transport,
    owns,
    batch,
  }: {
    id: string
    transport: ManagedTransport
    owns: () => Promise<boolean>
    batch: Batch
  }): Promise<void> {
    if (transport.selection.type !== "adapter" || transport.owner == null || !(await owns())) return
    const generation = transport.generation
    const patch = (value: Parameters<Wakeups["update"]>[0]["patch"]) =>
      this.wakeups.update({ id, generation, token: batch.token, patch: value })
    const probe = await this.dependencies.verify({ endpoint: transport.selection.endpoint, owner: transport.owner })
    if (!(await owns())) return
    if (probe.reason !== "verified-dedicated-agent") {
      // A working turn can last longer than the failure retry budget. Keep
      // checking at a bounded rate without counting normal work as a send failure.
      if (probe.reason === "busy") {
        patch({ reason: probe.reason, nextAttempt: Date.now() + 15000 })
        return
      }
      const permanent = ["owner-changed", "unsupported"].includes(probe.reason)
      const attempts = batch.attempts + 1
      patch({
        reason: probe.reason,
        attempts,
        outcome: permanent || attempts >= 8 ? "exhausted" : "pending",
        nextAttempt: Date.now() + Math.min(60000, 1000 * 2 ** attempts),
      })
      log.warn("managed notification deferred", { id, generation, reason: probe.reason, attempts })
      return
    }
    // Persist intent before launching. If the daemon dies after writing input,
    // restore holds it ambiguous rather than repeating a potentially accepted turn.
    if (!patch({ outcome: "sending", attempts: batch.attempts + 1 })) return
    const notification = `[agent-mesh] actor=${id} generation=${generation} batch=${batch.token}. Receive this batch with agent-mesh receive, then explicitly acknowledge its token with agent-mesh receipt. Receipt accepts work; execute requests in this turn and publish progress/results.`
    const result = await submitNotification({ endpoint: transport.selection.endpoint, notification, run: this.dependencies.run })
    if (!(await owns())) return
    patch({
      outcome:
        result.outcome === "ok"
          ? "submitted"
          : result.outcome === "ambiguous"
            ? "ambiguous"
            : batch.attempts >= 7
              ? "exhausted"
              : "pending",
      reason: result.reason,
      nextAttempt: Date.now() + Math.min(60000, 1000 * 2 ** (batch.attempts + 1)),
    })
    log.info("managed notification outcome", { id, generation, token: batch.token, outcome: result.outcome, reason: result.reason })
  }
}
