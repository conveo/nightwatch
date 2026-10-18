// Opting a device in to push notifications.
//
// ── Why this is not just Notification.requestPermission() ────────────────────
// On iOS, Safari grants Push ONLY to a site installed to the Home Screen. In a tab,
// `PushManager` is often absent entirely, and where it exists the permission request
// resolves to "denied" without ever showing a prompt. Asking anyway would burn the
// one prompt the browser gives you and leave you certain the feature is broken.
//
// So the hook reports WHY it cannot subscribe, and the UI tells you the one manual
// step only you can do: Share → Add to Home Screen, then open it from there.

import { useCallback, useEffect, useState } from "react"

export type PushState =
  | { kind: "unsupported"; reason: string }
  | { kind: "needs-install"; reason: string }
  | { kind: "blocked" }
  | { kind: "available"; devices: number }
  | { kind: "subscribed"; devices: number }
  /** This browser holds a subscription the SERVER no longer has. See `refresh`. */
  | { kind: "stale"; devices: number }

// iOS reports standalone through a non-standard property on navigator.
function isStandalone(): boolean {
  return window.matchMedia("(display-mode: standalone)").matches || (navigator as { standalone?: boolean }).standalone === true
}

function isIos(): boolean {
  return /iPad|iPhone|iPod/.test(navigator.userAgent)
}

export function usePushOptIn(): { state: PushState; enable: () => Promise<void>; disable: () => Promise<void>; busy: boolean } {
  const [state, setState] = useState<PushState>({ kind: "unsupported", reason: "checking…" })
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    if (!("serviceWorker" in navigator) || typeof window.PushManager === "undefined") {
      setState({
        kind: isIos() && !isStandalone() ? "needs-install" : "unsupported",
        reason: isIos() ? "iOS only allows notifications once the console is added to your Home Screen." : "This browser has no Push support.",
      })
      return
    }
    if (isIos() && !isStandalone()) {
      setState({ kind: "needs-install", reason: "iOS only allows notifications once the console is added to your Home Screen." })
      return
    }
    if (Notification.permission === "denied") {
      setState({ kind: "blocked" })
      return
    }
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const existing = await reg?.pushManager.getSubscription()
      // Ask about THIS endpoint, not just how many devices exist. A push service
      // invalidates an endpoint unilaterally (the app was removed, the browser rotated
      // it, it expired) and the server prunes it on the 404/410 — but the browser keeps
      // handing out the same dead subscription object forever. Reporting "subscribed"
      // from the browser copy alone is how push dies quietly: the toggle stays on, the
      // phone stays silent, and nothing anywhere says so.
      const query = existing != null ? `?endpoint=${encodeURIComponent(existing.endpoint)}` : ""
      const cfg = (await (await fetch(`/api/console/push${query}`)).json()) as { devices?: number; registered?: boolean | null }
      if (existing == null) {
        setState({ kind: "available", devices: cfg.devices ?? 0 })
        return
      }
      setState(cfg.registered === false ? { kind: "stale", devices: cfg.devices ?? 0 } : { kind: "subscribed", devices: cfg.devices ?? 0 })
    } catch {
      setState({ kind: "unsupported", reason: "Could not read the push configuration from the server." })
    }
  }, [])

  useEffect(() => {
    void refresh()
    // Re-check when they come back to the console. A subscription is pruned by a send
    // that happens while the tab is closed, so the mount-time answer can be hours stale
    // by the time they look — and "it broke while you were away" is precisely the case
    // this state exists to report.
    const recheck = () => {
      if (document.visibilityState === "visible") {
        void refresh()
      }
    }
    document.addEventListener("visibilitychange", recheck)
    return () => document.removeEventListener("visibilitychange", recheck)
  }, [refresh])

  const enable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.register("/sw.js", { scope: "/" })
      await navigator.serviceWorker.ready
      // Drop a dead subscription before asking for a new one. `subscribe()` on a
      // registration that already has one returns THAT one — so re-enabling after a
      // prune would hand the server back the very endpoint the push service rejected,
      // and the toggle would flip to "on" having fixed nothing.
      const stale = await reg.pushManager.getSubscription()
      if (stale != null) {
        await stale.unsubscribe().catch(() => undefined)
      }
      const permission = await Notification.requestPermission()
      if (permission !== "granted") {
        setState({ kind: "blocked" })
        return
      }
      const { publicKey } = (await (await fetch("/api/console/push")).json()) as { publicKey: string }
      const sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey),
      })
      await fetch("/api/console/push", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ subscription: sub.toJSON() }),
      })
      await refresh()
    } catch {
      setState({ kind: "unsupported", reason: "The browser refused the push subscription." })
    } finally {
      setBusy(false)
    }
  }, [refresh])

  const disable = useCallback(async () => {
    setBusy(true)
    try {
      const reg = await navigator.serviceWorker.getRegistration()
      const sub = await reg?.pushManager.getSubscription()
      if (sub != null) {
        // Tell the server FIRST: if the local unsubscribe succeeds and the POST does
        // not, the server keeps pushing to an endpoint that no longer exists.
        await fetch("/api/console/push", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ subscription: sub.toJSON(), unsubscribe: true }),
        })
        await sub.unsubscribe()
      }
      await refresh()
    } finally {
      setBusy(false)
    }
  }, [refresh])

  return { state, enable, disable, busy }
}

// VAPID keys travel as base64url; PushManager wants raw bytes. The buffer is
// allocated explicitly so the result is a Uint8Array<ArrayBuffer> — the DOM types
// reject the SharedArrayBuffer-capable default.
function urlBase64ToUint8Array(base64Url: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (base64Url.length % 4)) % 4)
  const base64 = (base64Url + padding).replace(/-/g, "+").replace(/_/g, "/")
  const raw = atob(base64)
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) {
    out[i] = raw.charCodeAt(i)
  }
  return out
}
