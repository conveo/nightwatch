// New chat, and the list of past ones.
//
// Discoverability is the requirement, not existence: the bar set was that doing a
// basic thing must not require messaging an agent to ask how. So this is a labelled
// button in the header — one tap from the conversation, visible without opening
// anything — and the list is one tap behind it.

import { Check, MessagesSquare, Moon, Plus, RefreshCw, Sun, X } from "lucide-react"
import { useState } from "react"
import { createPortal } from "react-dom"
import { relTime } from "@/lib/format"
import { cn } from "@/lib/utils"
import type { ConversationSummary } from "./useConversations"

export function NewChatButton({ onNew, compact }: { onNew: () => void; compact: boolean }) {
  return (
    <button
      aria-label="New chat"
      className={cn(
        "flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 font-medium transition-colors active:bg-accent hover:bg-accent/60",
        compact ? "h-9 px-3 text-[13px]" : "h-7 px-2.5 text-xs",
      )}
      onClick={onNew}
      type="button"
    >
      <Plus className="size-4" /> New
    </button>
  )
}

export function ChatListButton({
  conversations,
  active,
  onSelect,
  compact,
  console: consoleControls,
}: {
  conversations: ConversationSummary[]
  active: string
  onSelect: (id: string) => void
  compact: boolean
  /**
   * The console-level conveniences, or null on a surface that has room for them in
   * the header.
   *
   * They live here on a phone because of a causal chain worth keeping: adding New and
   * Chats crowded the header badly enough to be reported as a bug, the fix hid refresh
   * below 380px and the theme toggle below 420px (see MobileApp's header), and
   * a phone screen is about 390px wide — so the fix for the crowding is what made the
   * theme toggle unreachable on the very devices this was built for. A control does not
   * belong in a header it cannot fit in, and a sheet the operator already opens costs no
   * header width.
   */
  console: { theme: "light" | "dark"; onToggleTheme: () => void; onRefresh: () => void } | null
}) {
  const [open, setOpen] = useState(false)

  return (
    <>
      <button
        aria-label="Past chats"
        className={cn(
          "relative flex shrink-0 items-center gap-1.5 rounded-full border border-border/70 bg-card/60 font-medium transition-colors active:bg-accent hover:bg-accent/60",
          compact ? "h-9 px-3 text-[13px]" : "h-7 px-2.5 text-xs",
        )}
        onClick={() => setOpen(true)}
        type="button"
      >
        <MessagesSquare className="size-4" />
        {conversations.length > 1 && <span className="tabular">{conversations.length}</span>}
      </button>

      {/* Portalled to <body> deliberately. This button lives in a header that has
          `backdrop-blur`, and a backdrop-filter makes an ancestor the containing block
          for `position: fixed` — so an inline overlay renders CLIPPED TO THE HEADER
          while its content is still in the DOM, which reads as a blank panel rather
          than as a layout bug. Do not inline this back. */}
      {open &&
        createPortal(
          <div className="fixed inset-0 z-50 flex flex-col bg-background/95 backdrop-blur-xl" role="dialog">
          <div className="mesh-safe-top flex items-center gap-2 border-b border-border/70 px-3 pb-2">
            <p className="flex-1 text-[15px] font-medium">Chats</p>
            <button aria-label="Close" className="grid size-9 place-items-center rounded-full active:bg-accent" onClick={() => setOpen(false)} type="button">
              <X className="size-5" />
            </button>
          </div>
          <div className="mesh-scroll min-h-0 flex-1 overflow-y-auto">
            {conversations.length === 0 && <p className="px-4 py-10 text-center text-sm text-muted-foreground">No saved chats yet.</p>}
            <ul>
              {conversations.map((c) => (
                <li key={c.id}>
                  <button
                    className="flex w-full items-center gap-3 border-b border-border/50 px-3 py-3.5 text-left active:bg-accent/50"
                    onClick={() => {
                      onSelect(c.id)
                      setOpen(false)
                    }}
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14px] font-medium">{c.title}</span>
                      <span className="mt-0.5 block text-[12px] text-muted-foreground tabular">
                        {c.messages} message{c.messages === 1 ? "" : "s"} · {relTime(c.updatedAt)} ago
                      </span>
                    </span>
                    {c.id === active && <Check className="size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              ))}
            </ul>
            {consoleControls != null && (
              <div className="mt-2 border-t border-border/50 px-3 pt-3">
                <p className="text-[11px] uppercase tracking-wide text-muted-foreground/70">Console</p>
                <button
                  className="mt-1 flex w-full items-center gap-2.5 rounded-lg px-1 py-2.5 text-left text-[14px] active:bg-accent/50"
                  onClick={consoleControls.onToggleTheme}
                  type="button"
                >
                  {consoleControls.theme === "dark" ? <Sun className="size-4 shrink-0" /> : <Moon className="size-4 shrink-0" />}
                  Switch to {consoleControls.theme === "dark" ? "light" : "dark"}
                </button>
                <button
                  className="flex w-full items-center gap-2.5 rounded-lg px-1 py-2.5 text-left text-[14px] active:bg-accent/50"
                  onClick={() => {
                    consoleControls.onRefresh()
                    setOpen(false)
                  }}
                  type="button"
                >
                  <RefreshCw className="size-4 shrink-0" />
                  Refresh agents
                </button>
              </div>
            )}
            <div className="mesh-safe-bottom h-2" />
          </div>
        </div>,
          document.body,
        )}
    </>
  )
}
