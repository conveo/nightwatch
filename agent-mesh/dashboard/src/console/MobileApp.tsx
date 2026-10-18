// The phone shell. Chat-first: you land on one conversation with the mesh and push
// sideways into a specific agent's thread when you want the raw traffic.
//
// It is a separate SHELL from the desktop console, not a separate implementation —
// the views, the data hook and the voice controller are shared, and only the layout
// differs. A phone wants one thing at a time behind a back button; a 2560px monitor
// wants the list, the chat and the thread at once.

import { ChevronLeft, MessagesSquare, Moon, RefreshCw, Sun } from "lucide-react"
import { useCallback, useState } from "react"
import type { AgentRecord } from "@/lib/api"
import { useTheme } from "@/lib/useTheme"
import { cn } from "@/lib/utils"
import { StatusDot } from "@/components/ui/core"
import { splitAgentId } from "./console-api"
import { Console } from "./Console"
import { LiveThread } from "./LiveThread"
import { Threads } from "./Threads"
import { ChatListButton, NewChatButton } from "./ChatSwitcher"
import { useConsoleData } from "./useConsoleData"
import { useConversations } from "./useConversations"
import { useArrivals } from "./useArrivals"
import { useInboxStream } from "./useInboxStream"
import { useVoiceController } from "./useVoiceController"
import { VoiceSession } from "./VoiceSession"

type View = { kind: "console" } | { kind: "threads" } | { kind: "thread"; peer: string }

export default function MobileApp() {
  const { theme, toggle } = useTheme()
  const data = useConsoleData()
  // Voice is owned by the shell, not by the console view — the model's own
  // open_thread navigates away from it mid-sentence. See useVoiceController.
  const voice = useVoiceController()
  // One subscription per shell, not per view — an answer is most likely to land
  // while the operator is looking at something else.
  const { arrival } = useInboxStream()
  const chats = useConversations()
  const arrivalSink = useArrivals({ arrival, activeConversation: chats.active, onSaved: chats.refresh })
  const [view, setView] = useState<View>({ kind: "console" })

  // Navigating on the model's say-so is what pulled the operator out of the chat: the prompt
  // told it to "follow the conversation", and on a phone that means leaving the
  // conversation. An agent the assistant mentions is now OFFERED — a tappable chip in
  // the thread — and only a tap navigates. Their attention is theirs to move.
  const [offered, setOffered] = useState<string | null>(null)
  const offerThread = useCallback((peer: string) => setOffered(peer), [])
  const openThread = useCallback((peer: string) => {
    setOffered(null)
    setView({ kind: "thread", peer })
  }, [])

  if (data.configError != null) {
    return (
      <div className="mesh-mobile flex flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-sm font-medium text-destructive">Can't reach the mesh daemon</p>
        <p className="font-mono text-xs break-all text-muted-foreground">{data.configError}</p>
      </div>
    )
  }
  if (data.config == null) {
    return <div className="mesh-mobile grid place-items-center text-sm text-muted-foreground">connecting…</div>
  }

  return (
    <div className="mesh-mobile relative z-10 flex flex-col">
      <Header
        agents={data.agents}
        onBack={view.kind === "console" ? null : () => setView(view.kind === "thread" ? { kind: "threads" } : { kind: "console" })}
        onRefresh={data.refresh}
        onThreads={() => setView({ kind: "threads" })}
        onToggleTheme={toggle}
        online={data.online}
        theme={theme}
        chats={{ active: chats.active, list: chats.list, onNew: chats.create, onSelect: chats.select }}
        total={data.agents.length}
        unread={data.unread}
        view={view}
      />

      {/* The console stays MOUNTED and is hidden rather than swapped out: unmounting
          it would throw away the whole typed conversation (and its scroll position)
          every time the operator tapped into a thread and back. */}
      <div className={cn("flex min-h-0 flex-1 flex-col", view.kind !== "console" && "hidden")}>
        {/* Keyed by conversation: one instance per chat. See Console for why. */}
        <Console
          key={chats.active}
          activePeer={view.kind === "thread" ? view.peer : null}
          adoptVoiceRef={voice.adoptRef}
          arrivalSinkRef={arrivalSink}
          conversationId={chats.active}
          onConversationSaved={chats.refresh}
          agents={data.agents}
          config={data.config}
          layout="phone"
          micError={voice.micError}
          offeredThread={offered}
          onDismissOffered={() => setOffered(null)}
          onOpenOffered={openThread}
          onOpenThread={offerThread}
          onStartVoice={voice.start}
          voiceActive={voice.session != null}
          voiceMessages={voice.messages}
        />
      </div>
      {view.kind === "threads" && (
        <Threads agents={data.agents} hostname={data.config.hostname} onOpen={openThread} peers={data.peers} sentTo={data.sentTo} />
      )}
      {view.kind === "thread" && <LiveThread me={data.me} onSent={() => data.rememberSent(view.peer)} peer={view.peer} />}

      {voice.session != null && (
        <VoiceSession
          config={data.config}
          instructions={voice.session.instructions}
          onMessages={voice.setMessages}
          onOpenThread={offerThread}
          onStop={voice.stop}
          stream={voice.session.stream}
        />
      )}
    </div>
  )
}

function Header(args: {
  view: View
  agents: AgentRecord[]
  online: number
  total: number
  unread: number
  theme: "light" | "dark"
  onBack: (() => void) | null
  onThreads: () => void
  onRefresh: () => void
  onToggleTheme: () => void
  chats: { active: string; list: import("./useConversations").ConversationSummary[]; onNew: () => string; onSelect: (id: string) => void } | null
}) {
  const peer = args.view.kind === "thread" ? args.view.peer : null
  const agent = peer != null ? args.agents.find((a) => a.id === peer) : undefined
  const { scope, leaf } = peer != null ? splitAgentId(peer) : { scope: null, leaf: "" }

  return (
    <header className="mesh-safe-top z-20 flex items-center gap-2 border-b border-border/70 bg-background/85 px-2 pb-2 backdrop-blur-xl">
      {args.onBack != null ? (
        <button aria-label="Back" className="grid size-9 shrink-0 place-items-center rounded-full active:bg-accent" onClick={args.onBack} type="button">
          <ChevronLeft className="size-5" />
        </button>
      ) : (
        <span className="grid size-9 shrink-0 place-items-center">
          <span className="size-2.5 rounded-full bg-primary" />
        </span>
      )}

      <div className="min-w-0 flex-1 overflow-hidden">
        {peer != null ? (
          <>
            <p className="truncate font-mono text-[14px] font-medium leading-tight">
              {scope != null && <span className="text-muted-foreground/70">{scope}.</span>}
              {leaf}
            </p>
            <p className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              {agent != null ? (
                <>
                  <StatusDot status={agent.status} /> {agent.status} · {agent.role}
                </>
              ) : peer === "broadcast" ? (
                "mesh-wide channel"
              ) : peer.startsWith("host:") ? (
                "host fan-out · send only"
              ) : (
                "not in the registry"
              )}
            </p>
          </>
        ) : (
          <>
            {/* Truncate rather than wrap: with the chat controls beside it the title
                has little room on a 393px screen, and a two-line header pushes the
                whole conversation down. */}
            <p className="truncate text-[15px] font-medium leading-tight">{args.view.kind === "threads" ? "Conversations" : "agent mesh"}</p>
            <p className="truncate text-[11px] text-muted-foreground tabular">{args.online} online</p>
          </>
        )}
      </div>

      {args.view.kind === "console" && args.chats != null && (
        <>
          <NewChatButton compact onNew={args.chats.onNew} />
          <ChatListButton
            active={args.chats.active}
            compact
            console={{ theme: args.theme, onToggleTheme: args.onToggleTheme, onRefresh: args.onRefresh }}
            conversations={args.chats.list}
            onSelect={args.chats.onSelect}
          />
        </>
      )}
      {args.view.kind === "console" && (
        <button aria-label="Conversations" className="relative grid size-9 shrink-0 place-items-center rounded-full active:bg-accent" onClick={args.onThreads} type="button">
          <MessagesSquare className="size-5" />
          {args.unread > 0 && (
            <span className="absolute right-0.5 top-0.5 min-w-4 rounded-full bg-primary px-1 text-[10px] font-semibold leading-4 text-primary-foreground tabular">
              {args.unread > 99 ? "99+" : args.unread}
            </span>
          )}
        </button>
      )}
      {/* These two breakpoints FIX A REPORTED BUG. Do not delete them while tidying
          breakpoints.
          Adding New and Chats put seven items in this header, and every one of them is
          `shrink-0`, so the title block is the only thing that can give — it is the
          only flexible child. Measured with both of these forced visible: the title
          collapses to 69px at 393px (an iPhone 15 Pro, a typical phone width) and
          51px at 375px. "agent mesh" needs about 80px, so it truncates.
          It never overflows, which is why `scrollWidth - clientWidth` reads 0 and looks
          fine: flex takes the space out of the title instead. Measure the TITLE WIDTH,
          not the header's overflow, if you touch this.
          New and Chats keep their labels because they are the primary actions; refresh
          and the theme toggle are conveniences and give up their room first. The theme
          toggle therefore does not exist below 420px, so it also lives in the Chats
          sheet — see ChatSwitcher. */}
      <button aria-label="Refresh" className="hidden size-9 shrink-0 place-items-center rounded-full active:bg-accent min-[380px]:grid" onClick={args.onRefresh} type="button">
        <RefreshCw className="size-4.5" />
      </button>
      <button aria-label="Toggle theme" className="hidden size-9 shrink-0 place-items-center rounded-full active:bg-accent min-[420px]:grid" onClick={args.onToggleTheme} type="button">
        {args.theme === "dark" ? <Sun className="size-4.5" /> : <Moon className="size-4.5" />}
      </button>
    </header>
  )
}
