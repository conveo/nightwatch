// Service worker for the mesh console.
//
// Its ONLY job is push. There is deliberately no offline caching: this console is a
// live view of a mesh that is only reachable on the tailnet anyway, and a cached
// shell showing a stale roster would be worse than an honest failure to load.
//
// It exists at all because iOS Safari grants Push only to a site installed to the
// Home Screen, and only through a service worker.

self.addEventListener("install", () => self.skipWaiting())
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()))

self.addEventListener("push", (event) => {
  let data = { title: "agent-mesh", body: "New mesh activity.", url: "/?view=console" }
  try {
    data = { ...data, ...(event.data ? event.data.json() : {}) }
  } catch {
    // a non-JSON payload still deserves a notification rather than silence
  }
  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/favicon.png",
      badge: "/favicon.png",
      // One tag so a burst collapses into a single notification instead of stacking
      // a screenful the operator has to dismiss one by one.
      tag: "agent-mesh-inbox",
      renotify: true,
      data: { url: data.url },
    }),
  )
})

self.addEventListener("notificationclick", (event) => {
  event.notification.close()
  const url = (event.notification.data && event.notification.data.url) || "/?view=console"
  event.waitUntil(
    self.clients.matchAll({ type: "window", includeUncontrolled: true }).then((clients) => {
      // Focus the console if it is already open rather than opening a second copy.
      for (const client of clients) {
        if ("focus" in client) {
          client.navigate(url)
          return client.focus()
        }
      }
      return self.clients.openWindow(url)
    }),
  )
})
