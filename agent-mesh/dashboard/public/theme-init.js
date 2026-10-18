// Apply the theme before first paint (no flash). Stored choice wins, else
// follow the OS preference. A classic blocking script in <head> so it still
// runs before paint; it is a file rather than inline because the dashboard's
// CSP (script-src 'self') refuses inline scripts.
;(function () {
  try {
    var t = localStorage.getItem("agent-mesh-theme")
    if (t !== "light" && t !== "dark") {
      t = matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
    }
    document.documentElement.classList.toggle("dark", t === "dark")
    document.documentElement.style.colorScheme = t
  } catch (e) {
    document.documentElement.classList.add("dark")
  }
})()
