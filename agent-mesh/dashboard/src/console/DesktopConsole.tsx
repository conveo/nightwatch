// The console as a desktop tab: the same views the phone uses, laid out for width.
//
// A phone shows one thing at a time behind a back button. A monitor should not show
// the same single column stretched across 2560px — so here the conversation list, the
// chat and one agent's raw thread are all on screen at once, and the model's
// `open_thread` opens the right pane *beside* the chat instead of navigating away
// from it. Nothing is forked to achieve that: Console, Threads, ThreadView,
// VoiceSession and both hooks are the same modules the phone shell mounts.

import { PanelRightClose, RefreshCw } from "lucide-react"
import { useCallback, useState } from "react"
import { StatusDot } from "@/components/ui/core"
import { cn } from "@/lib/utils"
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

export function DesktopConsole() {
  const data = useConsoleData()
  const voice = useVoiceController()
  // One subscription per shell, not per view — an answer is most likely to land
  // while the operator is looking at something else.
  const { arrival } = useInboxStream()
  const chats = useConversations()
  const arrivalSink = useArrivals({ arrival, activeConversation: chats.active, onSaved: chats.refresh })
  // Opens on the broadcast channel rather than empty: on a wide screen an unused
  // third column is worse than a live one, and mesh-wide traffic is the thing worth
  // watching while you type. Selecting an agent swaps it; the close button collapses
  // it and gives the chat the full width.
  const [peer, setPeer] = useState<string | null>("broadcast")

  const openThread = useCallback((id: string) => setPeer(id), [])

  if (data.configError != null) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <p className="text-sm font-medium text-destructive">Can't reach the mesh daemon</p>
        <p className="font-mono text-xs text-muted-foreground">{data.configError}</p>
      </div>
    )
  }
  if (data.config == null) {
    return <div className="grid h-full place-items-center text-sm text-muted-foreground">connecting…</div>
  }

  const agent = peer != null ? data.agents.find((a) => a.id === peer) : undefined

  return (
    <div className="flex h-full min-h-0">
      {/* Conversations + roster. Same component the phone uses full-screen; it reads
          as a mail sidebar at this width without a second implementation. */}
      <aside className="flex w-[21rem] shrink-0 flex-col border-r border-border/70 bg-card/20">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">Conversations</span>
          {data.unread > 0 && (
            <span className="rounded-full bg-primary px-1.5 text-[10.5px] font-semibold text-primary-foreground tabular">{data.unread}</span>
          )}
          <button
            aria-label="Refresh"
            className="ml-auto grid size-6 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground"
            onClick={data.refresh}
            type="button"
          >
            <RefreshCw className="size-3.5" />
          </button>
        </div>
        <Threads agents={data.agents} hostname={data.config.hostname} onOpen={openThread} peers={data.peers} sentTo={data.sentTo} />
      </aside>

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
          <NewChatButton compact={false} onNew={chats.create} />
          {/* null: the desktop topbar already carries the theme toggle and refresh, so
              repeating them inside the sheet would be two ways to do the same thing. */}
          <ChatListButton active={chats.active} compact={false} console={null} conversations={chats.list} onSelect={chats.select} />
          <span className="truncate text-[11px] text-muted-foreground">{chats.list.find((c) => c.id === chats.active)?.title ?? "New chat"}</span>
        </div>
        {/* Keyed by conversation: one instance per chat. See Console for why. */}
        <Console
          key={chats.active}
          conversationId={chats.active}
          onConversationSaved={chats.refresh}
          activePeer={peer}
          adoptVoiceRef={voice.adoptRef}
          arrivalSinkRef={arrivalSink}
          agents={data.agents}
          config={data.config}
          layout="wide"
          offeredThread={null}
          onDismissOffered={() => undefined}
          onOpenOffered={openThread}
          micError={voice.micError}
          onOpenThread={openThread}
          onStartVoice={voice.start}
          voiceActive={voice.session != null}
          voiceMessages={voice.messages}
        />
        {voice.session != null && (
          <VoiceSession
            config={data.config}
            instructions={voice.session.instructions}
            onMessages={voice.setMessages}
            onOpenThread={openThread}
            onStop={voice.stop}
            stream={voice.session.stream}
          />
        )}
      </main>

      {peer != null && (
        <aside className="flex w-[27rem] shrink-0 flex-col border-l border-border/70 bg-card/20">
          <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border/60 px-3">
            <div className="min-w-0 flex-1">
              <p className="truncate font-mono text-[12.5px] font-medium leading-tight">
                {(() => {
                  const { scope, leaf } = splitAgentId(peer)
                  return (
                    <>
                      {scope != null && <span className="text-muted-foreground/70">{scope}.</span>}
                      {leaf}
                    </>
                  )
                })()}
              </p>
              <p className="flex items-center gap-1.5 text-[10.5px] text-muted-foreground">
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
            </div>
            <button
              aria-label="Close thread"
              className={cn("grid size-6 shrink-0 place-items-center rounded-md text-muted-foreground transition-colors hover:bg-accent/60 hover:text-foreground")}
              onClick={() => setPeer(null)}
              type="button"
            >
              <PanelRightClose className="size-4" />
            </button>
          </div>
          <LiveThread me={data.me} onSent={() => data.rememberSent(peer)} peer={peer} />
        </aside>
      )}
    </div>
  )
}
