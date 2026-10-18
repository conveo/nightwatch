// Web Push, so an answer reaches the operator's pocket and not only a foreground tab.
//
// ── The iOS constraint that shapes all of this ───────────────────────────────
// Safari on iOS grants Push ONLY to a site installed to the Home Screen. Not to a
// tab, however permitted. So the console ships a manifest and a service worker, and
// the operator has to "Add to Home Screen" once by hand — that step cannot be automated
// from here, and the opt-in UI says so rather than asking for a permission the
// browser will silently refuse.
//
// ── When a push is sent ──────────────────────────────────────────────────────
// Only when NO tab is listening. A live SSE subscriber already narrates in the
// conversation; pushing as well would notify them about something they are watching
// arrive. `InboxWatcher.subscriberCount` is exactly that signal.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import webpush from "web-push"
import { consoleDatabaseDir } from "./console-db-url.js"

// VAPID identifies this server to the push service. The keypair must SURVIVE
// restarts: regenerating it silently invalidates every subscription the browser
// still believes in, and the failure looks like "push just stopped working".
//
// Overridable for the same reason the transcript and the inbox cursor are: every
// console on this box shares one mesh home, so a throwaway instance would otherwise
// register and prune subscriptions in the file the live console pushes from.
const KEY_FILE = () => {
  const override = process.env.CONSOLE_PUSH_FILE
  if (override != null && override !== "") {
    return override
  }
  return join(consoleDatabaseDir(), "console-push.json")
}

type Stored = {
  publicKey: string
  privateKey: string
  subscriptions: webpush.PushSubscription[]
}

function load(): Stored {
  const file = KEY_FILE()
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>
      if (typeof parsed.publicKey === "string" && typeof parsed.privateKey === "string") {
        return { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subscriptions: parsed.subscriptions ?? [] }
      }
    } catch {
      // fall through and regenerate — a corrupt file costs a re-subscribe, and
      // refusing to start the console over it would be worse
    }
  }
  const keys = webpush.generateVAPIDKeys()
  const fresh: Stored = { publicKey: keys.publicKey, privateKey: keys.privateKey, subscriptions: [] }
  save(fresh)
  return fresh
}

function save(state: Stored): void {
  const file = KEY_FILE()
  mkdirSync(dirname(file), { recursive: true })
  // 0600: the private key is a credential, and ~/.agent-mesh is shared with every
  // agent process on this box.
  writeFileSync(file, JSON.stringify(state, null, 2), { mode: 0o600 })
}

// Push services expect a mailto: or https: contact for the operator.
function pushSubject(): string {
  const raw = process.env.AGENT_MESH_PUSH_SUBJECT
  return raw != null && raw.trim() !== "" ? raw.trim() : "mailto:agent-mesh@example.com"
}

let state: Stored | null = null
function current(): Stored {
  if (state == null) {
    state = load()
    webpush.setVapidDetails(pushSubject(), state.publicKey, state.privateKey)
  }
  return state
}

export function pushPublicKey(): string {
  return current().publicKey
}

export function pushSubscriberCount(): number {
  return current().subscriptions.length
}

/**
 * Does the server still hold THIS browser's subscription?
 *
 * A browser keeps its PushSubscription object long after the push service has
 * invalidated the endpoint, so `pushManager.getSubscription() != null` means "this
 * device once subscribed", not "notifications will arrive". Only the server knows
 * whether the endpoint survived its last send. Without this the opt-in UI reads
 * "subscribed" while the server has nobody to push to — a silent failure of the one
 * mechanism that exists to prevent silent failures.
 */
export function hasSubscription(endpoint: string): boolean {
  return current().subscriptions.some((s) => s.endpoint === endpoint)
}

// Why a subscription went away, kept in memory for the diagnostics endpoint. A prune
// is normal and permanent, and it is invisible everywhere else: the push just stops.
// Bounded because it is a debugging aid, not a log.
const PRUNE_HISTORY = 20
const pruned: { at: string; host: string; status: number }[] = []

export function pushPruneHistory(): { at: string; host: string; status: number }[] {
  return [...pruned]
}

function recordPrune(endpoint: string, status: number): void {
  // Host only, never the full endpoint: the endpoint is the capability to notify this
  // device, and diagnostics is an unauthenticated local route.
  const host = (() => {
    try {
      return new URL(endpoint).host
    } catch {
      return "unknown"
    }
  })()
  pruned.push({ at: new Date().toISOString(), host, status })
  if (pruned.length > PRUNE_HISTORY) {
    pruned.shift()
  }
}

/** Idempotent: re-subscribing the same endpoint replaces it rather than duplicating. */
// Browsers hand out endpoints on their vendor's push service. web-push POSTs to
// whatever endpoint is registered, so anything else would let a caller point this
// server at an arbitrary host.
const PUSH_SERVICE_HOSTS = ["fcm.googleapis.com", "push.apple.com", "push.services.mozilla.com", "notify.windows.com"]
// Devices kept per server; registering one more drops the oldest.
const MAX_SUBSCRIPTIONS = 10

export function isPushServiceEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint)
    const host = url.hostname.toLowerCase()
    return url.protocol === "https:" && url.port === "" && PUSH_SERVICE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`))
  } catch {
    return false
  }
}

export function addSubscription(sub: webpush.PushSubscription): void {
  const s = current()
  s.subscriptions = [...s.subscriptions.filter((x) => x.endpoint !== sub.endpoint), sub].slice(-MAX_SUBSCRIPTIONS)
  save(s)
}

export function removeSubscription(endpoint: string): void {
  const s = current()
  s.subscriptions = s.subscriptions.filter((x) => x.endpoint !== endpoint)
  save(s)
}

/**
 * Send one notification to every registered device.
 *
 * A 404/410 from the push service means the subscription is permanently dead (the
 * app was uninstalled, or the browser rotated it). Those are pruned on the spot —
 * left in place they turn every later push into a burst of certain failures.
 */
export async function sendPush(args: { title: string; body: string; url: string }): Promise<{ sent: number; pruned: number; failed: number }> {
  const s = current()
  if (s.subscriptions.length === 0) {
    return { sent: 0, pruned: 0, failed: 0 }
  }
  const payload = JSON.stringify({ title: args.title, body: args.body, url: args.url })
  let sent = 0
  let pruned = 0
  let failed = 0
  await Promise.all(
    s.subscriptions.map(async (sub) => {
      try {
        await webpush.sendNotification(sub, payload, { TTL: 600 })
        sent += 1
      } catch (e) {
        const status = (e as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          recordPrune(sub.endpoint, status)
          removeSubscription(sub.endpoint)
          pruned += 1
          return
        }
        failed += 1
      }
    }),
  )
  return { sent, pruned, failed }
}
