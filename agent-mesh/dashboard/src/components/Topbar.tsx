import { MessageSquarePlus, Moon, Sun, WifiOff } from "lucide-react"
import type { Health } from "@/lib/api"
import type { DesktopView } from "@/lib/useDesktopView"
import { DESKTOP_VIEWS } from "@/lib/useDesktopView"
import { useTheme } from "@/lib/useTheme"
import { cn } from "@/lib/utils"
import { Button } from "./ui/core"

export function Topbar({
  health,
  connected,
  online,
  total,
  onCompose,
  view,
  setView,
}: {
  health: Health | null
  connected: boolean
  online: number
  total: number
  onCompose: () => void
  view: DesktopView
  setView: (v: DesktopView) => void
}) {
  const { theme, toggle } = useTheme()
  return (
    <header className="flex h-12 shrink-0 items-center gap-3 border-b border-border/70 px-4">
      <div className="flex items-center gap-2">
        <img src="/agentmesh-mark.svg" alt="agent-mesh" className="size-6" width={24} height={24} />
        <span className="font-mono text-[13px] font-semibold tracking-tight">agent-mesh</span>
      </div>

      <div className="flex items-center gap-1">
        {DESKTOP_VIEWS.map((v) => (
          <Button key={v.id} onClick={() => setView(v.id)} size="sm" variant={view === v.id ? "primary" : "ghost"}>
            {v.label}
          </Button>
        ))}
      </div>

      <div
        className={cn(
          "flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px]",
          connected ? "border-border/60 bg-muted/40" : "border-destructive/40 bg-destructive/10",
        )}
      >
        {connected ? (
          <>
            <span className="size-1.5 animate-meshpulse rounded-full bg-status-online" />
            <span className="font-mono text-muted-foreground">{health?.hostname ?? "…"}</span>
          </>
        ) : (
          <>
            <WifiOff className="size-3 text-destructive" />
            <span className="text-destructive">daemon unreachable</span>
          </>
        )}
      </div>

      <div className="ml-auto flex items-center gap-3">
        <span className="tabular text-[11px] text-muted-foreground">
          <span className="text-status-online">{online}</span> online
          <span className="mx-1 text-border">·</span>
          <span className="text-foreground/80">{total}</span> registered
        </span>
        <Button variant="ghost" size="iconSm" onClick={toggle} title={`Switch to ${theme === "dark" ? "light" : "dark"} theme`}>
          {theme === "dark" ? <Sun className="size-3.5" /> : <Moon className="size-3.5" />}
        </Button>
        <Button variant="primary" size="sm" onClick={onCompose}>
          <MessageSquarePlus className="size-3.5" /> Compose
        </Button>
      </div>
    </header>
  )
}
