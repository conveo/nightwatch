// A direct mesh conversation with one agent — the messaging half of the console.
//
// Nothing here goes through a model: what you type is published verbatim as a mesh
// message from your operator id. The composer is AI Elements' PromptInput so
// the two surfaces feel like one product, but the wire is plain /api/publish.

import { Conversation, ConversationContent, ConversationEmptyState, ConversationScrollButton } from "@/components/ai-elements/conversation"
import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { PromptInput, PromptInputBody, PromptInputFooter, PromptInputSubmit, PromptInputTextarea, PromptInputTools } from "@/components/ai-elements/prompt-input"
import { Radio, TriangleAlert } from "lucide-react"
import { useEffect, useRef, useState } from "react"
import { MESSAGE_TYPES, type MeshMessage } from "@/lib/api"
import { dayLabel, sameDay, TYPE_STYLE } from "@/lib/format"
import { cn } from "@/lib/utils"
import { bodyToText, sendMeshMessage } from "./console-api"

type Props = {
  peer: string
  me: string
  messages: MeshMessage[]
  sendOnly: boolean
  loading: boolean
  onSent: (id: string) => void
}

/** Optimistic rows carry a temporary stream id so they can be reconciled on the next poll. */
type Pending = { key: string; text: string; type: MeshMessage["type"]; at: string; failed: string | null }

export function ThreadView({ peer, me, messages, sendOnly, loading, onSent }: Props) {
  const [type, setType] = useState<MeshMessage["type"]>("note")
  const [pending, setPending] = useState<Pending[]>([])
  const seenIds = useRef(new Set<string>())

  // Drop an optimistic row once its real counterpart comes back from the server.
  // Matching on text rather than id is the only option — publish returns the id
  // but the poll that carries the row may land first, and a duplicate bubble is
  // more confusing than a half-second of the optimistic one.
  useEffect(() => {
    if (pending.length === 0) {
      return
    }
    const landed = new Set(messages.filter((m) => m.from === me).map((m) => bodyToText(m.body)))
    setPending((prev) => prev.filter((p) => p.failed != null || !landed.has(p.text)))
  }, [messages, me, pending.length])

  useEffect(() => {
    setPending([])
    seenIds.current = new Set()
  }, [peer])

  const send = async (text: string) => {
    const key = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    setPending((prev) => [...prev, { key, text, type, at: new Date().toISOString(), failed: null }])
    try {
      const res = await sendMeshMessage({ me, to: peer, type, text, correlationId: null })
      onSent(res.id)
    } catch (e) {
      setPending((prev) => prev.map((p) => (p.key === key ? { ...p, failed: (e as Error).message } : p)))
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Conversation className="mesh-scroll min-h-0 flex-1">
        <ConversationContent className="gap-3 px-3 py-4">
          {messages.length === 0 && pending.length === 0 && !loading && (
            <ConversationEmptyState
              description={
                sendOnly
                  ? "A host fan-out reaches every agent on that machine. Messages send, but the host stream has no readable history — what you send from here is shown until you leave."
                  : "Nothing between you and this agent yet."
              }
              icon={<Radio className="size-6" />}
              title={sendOnly ? "Host fan-out" : "No messages"}
            />
          )}

          {messages.map((m, i) => {
            const prev = i > 0 ? messages[i - 1] : null
            const newDay = prev == null || !sameDay(prev.ts, m.ts)
            return (
              <div key={`${m.channel}:${m.id}`}>
                {newDay && <p className="py-2 text-center text-[11px] uppercase tracking-wide text-muted-foreground/70">{dayLabel(m.ts)}</p>}
                <MeshBubble me={me} message={m} />
              </div>
            )
          })}

          {pending.map((p) => (
            <Message from="user" key={p.key}>
              <MessageContent
                className={cn(
                  "group-[.is-user]:max-w-[88%] group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-[15px]",
                  p.failed != null
                    ? "group-[.is-user]:bg-destructive/15 group-[.is-user]:text-destructive"
                    : "group-[.is-user]:bg-primary/70 group-[.is-user]:text-primary-foreground",
                )}
              >
                <p className="whitespace-pre-wrap leading-snug">{p.text}</p>
                <p className="mt-1 flex items-center gap-1 text-[10.5px] opacity-80">
                  {p.failed != null ? (
                    <>
                      <TriangleAlert className="size-3" /> {p.failed}
                    </>
                  ) : (
                    "sending…"
                  )}
                </p>
              </MessageContent>
            </Message>
          ))}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      <div className="mesh-safe-bottom border-t border-border/70 bg-card/70 px-3 pt-2.5 backdrop-blur-xl">
        <PromptInput
          onSubmit={(msg) => {
            if (msg.text.trim() === "") {
              return
            }
            void send(msg.text.trim())
          }}
        >
          <PromptInputBody>
            <PromptInputTextarea placeholder={`Message ${peer}…`} />
          </PromptInputBody>
          <PromptInputFooter className="flex-wrap gap-y-1.5">
              <PromptInputTools className="flex-wrap gap-1">
                {MESSAGE_TYPES.map((t) => (
                  <button
                    className={cn(
                      "shrink-0 rounded-full border px-2.5 py-1 text-[12px] transition-colors",
                      type === t ? "border-transparent text-background" : "border-border/60 text-muted-foreground",
                    )}
                    key={t}
                    onClick={() => setType(t)}
                    style={type === t ? { backgroundColor: TYPE_STYLE[t].color } : undefined}
                    type="button"
                  >
                    {t}
                  </button>
                ))}
              </PromptInputTools>
              <PromptInputSubmit className="size-9 shrink-0 rounded-full" status="ready" />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  )
}

function MeshBubble({ message, me }: { message: MeshMessage; me: string }) {
  const mine = message.from === me
  const style = TYPE_STYLE[message.type]
  const text = bodyToText(message.body)
  const at = new Date(message.ts).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })

  return (
    <Message from={mine ? "user" : "assistant"}>
      <MessageContent
        className={cn(
          "max-w-[88%] rounded-2xl px-3.5 py-2.5",
          mine
            ? "group-[.is-user]:rounded-br-md group-[.is-user]:bg-primary group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-primary-foreground"
            : "rounded-bl-md border border-border/60 bg-card",
        )}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-[10.5px] font-semibold uppercase tracking-wide" style={{ color: mine ? undefined : style.color }}>
            {message.type}
          </span>
          {!mine && <span className="truncate font-mono text-[10.5px] text-muted-foreground">{message.from}</span>}
          {message.to === "broadcast" && <span className="rounded-full border border-border/60 px-1.5 text-[10px] text-muted-foreground">broadcast</span>}
          <span className={cn("ml-auto shrink-0 text-[10.5px] tabular", mine ? "text-primary-foreground/70" : "text-muted-foreground")}>{at}</span>
        </div>
        <MessageResponse className={cn("mesh-prose mt-1", mine && "text-primary-foreground")}>{text}</MessageResponse>
        {message.correlationId != null && (
          <p className={cn("mt-1 font-mono text-[10px]", mine ? "text-primary-foreground/60" : "text-muted-foreground/70")}>corr {message.correlationId}</p>
        )}
      </MessageContent>
    </Message>
  )
}
