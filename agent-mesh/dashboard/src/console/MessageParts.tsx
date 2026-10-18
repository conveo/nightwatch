// Rendering for the parts of an assistant UIMessage, shared by the typed chat and
// the voice transcript — both produce plain `UIMessage[]`, so one renderer covers
// them and a tool call looks the same whether it was typed or spoken.

import { Message, MessageContent, MessageResponse } from "@/components/ai-elements/message"
import { Reasoning, ReasoningContent, ReasoningTrigger } from "@/components/ai-elements/reasoning"
import { Tool, ToolContent, ToolHeader, ToolInput, ToolOutput } from "@/components/ai-elements/tool"
import type { ToolUIPart, UIMessage } from "ai"
import { useState } from "react"
import { ChevronRight, Send } from "lucide-react"
import { TYPE_STYLE } from "@/lib/format"
import { receiptLabel, useReceipt } from "./useReceipt"
import { cn } from "@/lib/utils"

// A one-line human summary for the tool chips. The generic Tool card is still
// available underneath (tap to expand) — this is what you read at a glance while
// walking, which is most of what this console is for.
const TOOL_LABEL: Record<string, string> = {
  list_agents: "Looking up agents",
  read_thread: "Reading a thread",
  read_inbox: "Reading your inbox",
  send_message: "Sending a mesh message",
  open_thread: "Opening a thread",
  mesh_overview: "Checking the mesh",
  inspect_agent: "Inspecting",
  nudge_agent: "Nudging",
}

function toolName(type: string): string {
  return type.startsWith("tool-") ? type.slice("tool-".length) : type
}

// A tool-call loop reads several threads in a row, and a column of identical
// "Reading a thread" cards tells you nothing about what it looked at. The argument
// is the only thing that distinguishes them, so it goes in the title.
function toolTitle(name: string, input: unknown): string {
  const label = TOOL_LABEL[name] ?? name
  const args = (input ?? {}) as { agent?: unknown; to?: unknown; query?: unknown }
  const subject =
    typeof args.agent === "string" && args.agent !== ""
      ? args.agent
      : typeof args.to === "string" && args.to !== ""
        ? args.to
        : typeof args.query === "string" && args.query.trim() !== ""
          ? `“${args.query.trim()}”`
          : null
  return subject == null ? label : `${label} · ${subject}`
}

/**
 * A sent message is the one tool result worth promoting out of a collapsed card:
 * it is the only one with a side effect on the mesh, and the operator needs to see what
 * actually went out without expanding anything.
 */
function SentReceipt({ part }: { part: ToolUIPart }) {
  const out = part.output as { sent?: boolean; nudged?: boolean; to?: string; type?: string; error?: string; correlationId?: string; at?: string } | undefined
  // Hooks run before the early returns below: a card that is still streaming, or that
  // failed, must not change how many hooks this component calls.
  const sentAt = typeof out?.at === "string" ? Date.parse(out.at) : Number.NaN
  const receipt = useReceipt({
    correlationId: out?.sent === true && typeof out.correlationId === "string" ? out.correlationId : "",
    to: typeof out?.to === "string" ? out.to : "",
    sentAtMs: Number.isFinite(sentAt) ? sentAt : null,
  })
  if (out == null) {
    return null
  }
  // A nudge that was REFUSED (dead or stale recipient) is the most useful receipt of
  // the lot: it is the difference between "sent" and "reached".
  if (out.sent !== true && out.nudged !== true) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-[13px] text-destructive">
        Not sent — {out.error ?? "publish rejected"}
      </div>
    )
  }
  const input = part.input as { text?: string } | undefined
  return (
    <div className="rounded-lg border border-status-online/35 bg-status-online/10 px-3 py-2">
      <p className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wide text-status-online">
        <Send className="size-3" /> {out.nudged === true ? "nudged" : `sent · ${out.type ?? ""}`} → <span className="font-mono normal-case tracking-normal">{out.to}</span>
      </p>
      {input?.text != null && <p className="mt-1 text-[13px] leading-snug text-foreground/85">{input.text}</p>}
      {receipt != null && <ReceiptLine receipt={receipt} />}
    </div>
  )
}

function ReceiptLine({ receipt }: { receipt: NonNullable<ReturnType<typeof useReceipt>> }) {
  const { text, tone } = receiptLabel(receipt)
  return (
    <p
      className={cn(
        "mt-1.5 text-[11px]",
        tone === "good" && "text-status-online",
        tone === "waiting" && "text-muted-foreground",
        // An honest shrug reads as a shrug. Styling "unknown" like "delivered" is how a
        // badge starts being believed about things it never knew.
        tone === "unknown" && "italic text-muted-foreground/70",
      )}
    >
      {text}
    </p>
  )
}

function ToolPart({ part }: { part: ToolUIPart }) {
  const name = toolName(part.type)
  const done = part.state === "output-available" || part.state === "output-error"

  if ((name === "send_message" || name === "nudge_agent") && part.state === "output-available") {
    return <SentReceipt part={part} />
  }
  // open_thread has already moved the screen; a card about it would just be noise.
  if (name === "open_thread") {
    return null
  }
  return (
    <Tool className="mb-0 border-border/60 bg-card/40">
      <ToolHeader
        className="p-2.5"
        state={part.state}
        title={toolTitle(name, part.input)}
        type={part.type}
      />
      <ToolContent>
        <ToolInput input={part.input} />
        {done && <ToolOutput errorText={part.errorText} output={part.output} />}
      </ToolContent>
    </Tool>
  )
}

export function AssistantMessage({ message }: { message: UIMessage }) {
  const isUser = message.role === "user"
  // A participant turn: sent by an agent, not by the console assistant. It is labelled
  // with WHO said it, because an unattributed reply in a multi-participant room is
  // indistinguishable from the assistant having said it.
  const meta = message.metadata as { author?: string; meshType?: string; at?: string; raw?: MeshRaw[] } | undefined
  const author = typeof meta?.author === "string" ? meta.author : null
  const raw = Array.isArray(meta?.raw) ? meta.raw : null
  // A realtime session opens a user message as soon as it hears audio, before the
  // transcript arrives — and emits one that stays empty for a cough or a passing
  // car. Rendering those puts blank bubbles down the thread.
  const empty = message.parts.every((p) => (p.type === "text" || p.type === "reasoning") && p.text.trim() === "")
  if (empty) {
    return null
  }
  return (
    <Message from={message.role}>
      {author != null && <MeshEntryHeader author={author} at={meta?.at} count={raw?.length ?? 1} meshType={meta?.meshType} />}
      <MessageContent
        className={cn(
          author != null && "rounded-xl border border-border/60 bg-card px-3.5 py-2.5",
          isUser && "group-[.is-user]:max-w-[88%] group-[.is-user]:rounded-2xl group-[.is-user]:rounded-br-md group-[.is-user]:bg-primary group-[.is-user]:px-3.5 group-[.is-user]:py-2.5 group-[.is-user]:text-[15px] group-[.is-user]:text-primary-foreground",
          !isUser && "gap-2.5",
        )}
      >
        {message.parts.map((part, i) => {
          const key = `${message.id}-${i}`
          if (part.type === "text") {
            return isUser ? (
              <p className="whitespace-pre-wrap leading-snug" key={key}>
                {part.text}
              </p>
            ) : (
              <MessageResponse className="mesh-prose" key={key}>
                {part.text}
              </MessageResponse>
            )
          }
          if (part.type === "reasoning") {
            return (
              <Reasoning className="w-full" isStreaming={part.state === "streaming"} key={key}>
                <ReasoningTrigger />
                <ReasoningContent>{part.text}</ReasoningContent>
              </Reasoning>
            )
          }
          if (part.type.startsWith("tool-")) {
            return <ToolPart key={key} part={part as ToolUIPart} />
          }
          return null
        })}
        {raw != null && <RawMeshDetails raw={raw} />}
      </MessageContent>
    </Message>
  )
}

type MeshRaw = { id: string; author: string; type: string; at: string; correlationId: string | null; text: string }

function MeshEntryHeader({ author, at, meshType, count }: { author: string; at?: string; meshType?: string; count: number }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px]">
      {meshType != null && (
        <span className="shrink-0 font-semibold uppercase tracking-wide" style={{ color: TYPE_STYLE[meshType as keyof typeof TYPE_STYLE]?.color }}>
          {meshType}
        </span>
      )}
      <span className="truncate font-mono text-muted-foreground">{author}</span>
      {count > 1 && <span className="shrink-0 text-muted-foreground/70">+{count - 1}</span>}
      {at != null && <span className="ml-auto shrink-0 tabular text-muted-foreground/70">{new Date(at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>}
    </p>
  )
}

/**
 * The raw agent message, behind an explicit affordance.
 *
 * Collapsed is the default because the recap above is what the operator reads — the timeline has
 * to be readable without them parsing agent payloads. But the raw is never discarded:
 * author and correlation are shown with it, so an answer can always be traced to the
 * request that caused it.
 */
function RawMeshDetails({ raw }: { raw: MeshRaw[] }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="mt-1">
      <button
        className="flex items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
        onClick={() => setOpen((o) => !o)}
        type="button"
      >
        <ChevronRight className={cn("size-3 transition-transform", open && "rotate-90")} />
        {open ? "Hide" : "Show"} original{raw.length > 1 ? ` (${raw.length})` : ""}
      </button>
      {open && (
        <div className="mt-1.5 flex flex-col gap-2">
          {raw.map((r) => (
            <div className="rounded-lg border border-border/60 bg-muted/30 px-2.5 py-2" key={r.id}>
              <p className="flex flex-wrap items-center gap-x-1.5 text-[10.5px]">
                <span className="font-semibold uppercase tracking-wide" style={{ color: TYPE_STYLE[r.type as keyof typeof TYPE_STYLE]?.color }}>
                  {r.type}
                </span>
                <span className="truncate font-mono text-muted-foreground">{r.author}</span>
                <span className="tabular text-muted-foreground/70">{new Date(r.at).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" })}</span>
              </p>
              {/* Markdown, not pre-wrap: `bodyToText` renders a structured body as prose with
                  bold keys, and the thread view already shows mesh bodies that way. Plain text
                  here would put literal `**` in front of every field. */}
              <MessageResponse className="mesh-prose mt-1 text-[12.5px] leading-snug text-foreground/85">{r.text}</MessageResponse>
              {r.correlationId != null && <p className="mt-1 font-mono text-[10px] text-muted-foreground/70">corr {r.correlationId}</p>}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
