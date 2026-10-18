import { ChevronDown, Radio, Send, Server, User } from "lucide-react"
import { useEffect, useMemo, useState } from "react"
import { type AgentRecord, hostLabel, MESSAGE_TYPES, api } from "@/lib/api"
import { cn } from "@/lib/utils"
import { Button, Input, Label, Textarea } from "./ui/core"
import { Dialog, DialogContent, DialogTitle } from "./ui/dialog"
import { Popover, PopoverContent, PopoverTrigger } from "./ui/popover"

type Props = {
  open: boolean
  onOpenChange: (o: boolean) => void
  initialTo: string | null
  agents: AgentRecord[]
  onSent: () => void
}

type Target = { value: string; kind: "broadcast" | "host" | "agent"; label: string }

export function Composer({ open, onOpenChange, initialTo, agents, onSent }: Props) {
  const [to, setTo] = useState("broadcast")
  const [type, setType] = useState<(typeof MESSAGE_TYPES)[number]>("note")
  const [corr, setCorr] = useState("")
  const [body, setBody] = useState("{\n  \n}")
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [sending, setSending] = useState(false)

  useEffect(() => {
    if (open) {
      setTo(initialTo ?? "broadcast")
      setResult(null)
    }
  }, [open, initialTo])

  const targets = useMemo<Target[]>(() => {
    const rawHosts = [...new Set(agents.map((a) => a.host).filter((h): h is string => h != null && h !== ""))].sort()
    return [
      { value: "broadcast", kind: "broadcast", label: "broadcast — whole mesh (rarely needed)" },
      ...rawHosts.map((h) => ({ value: `host:${h}`, kind: "host" as const, label: `host:${hostLabel(h)} — everyone on this host` })),
      ...agents.map((a) => ({ value: a.id, kind: "agent" as const, label: a.id })),
    ]
  }, [agents])

  const send = async () => {
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(body) as Record<string, unknown>
      if (typeof parsed !== "object" || parsed == null || Array.isArray(parsed)) {
        throw new Error("body must be a JSON object")
      }
    } catch (e) {
      setResult({ ok: false, text: `Invalid JSON body: ${(e as Error).message}` })
      return
    }
    setSending(true)
    try {
      const res = await api.publish({ from: "operator", to, type, body: parsed, correlationId: corr.trim() || null, replyTo: null })
      if (res.error != null || res.id == null) {
        setResult({ ok: false, text: `Failed: ${JSON.stringify(res.error ?? res)}` })
        return
      }
      setResult({ ok: true, text: `Sent ${res.id} → ${res.to}` })
      onSent()
    } catch (e) {
      // publish rejected (network down, or a non-2xx response now guarded in
      // api.postJson) — surface it and always release the button (a bare `await`
      // throw here would otherwise wedge it on "Sending…").
      setResult({ ok: false, text: `Failed: ${(e as Error).message}` })
    } finally {
      setSending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-[34rem]">
        <DialogTitle className="text-sm font-medium">Publish message</DialogTitle>

        <div className="mt-4 flex flex-col gap-3.5">
          <div className="flex flex-col gap-1.5">
            <Label>Recipient</Label>
            <TargetPicker targets={targets} value={to} onPick={setTo} />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Type</Label>
            <div className="flex flex-wrap gap-1">
              {MESSAGE_TYPES.map((t) => (
                <button
                  key={t}
                  onClick={() => setType(t)}
                  className={cn(
                    "rounded-md border px-2.5 py-1 text-xs capitalize transition-colors",
                    type === t ? "border-primary/50 bg-primary/15 text-primary" : "border-border/60 text-muted-foreground hover:text-foreground",
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Correlation id (optional)</Label>
            <Input value={corr} onChange={(e) => setCorr(e.target.value)} placeholder="blk-1" className="font-mono" />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label>Body (JSON)</Label>
            <Textarea value={body} onChange={(e) => setBody(e.target.value)} spellCheck={false} className="min-h-[120px]" />
          </div>

          {result != null && (
            <p className={cn("font-mono text-xs", result.ok ? "text-status-online" : "text-destructive")}>{result.text}</p>
          )}

          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={send} disabled={sending}>
              <Send className="size-3.5" /> {sending ? "Sending…" : "Publish"}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  )
}

function TargetPicker({ targets, value, onPick }: { targets: Target[]; value: string; onPick: (v: string) => void }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState("")
  const list = targets.filter((t) => t.value.toLowerCase().includes(q.toLowerCase()))
  const current = targets.find((t) => t.value === value)
  const Icon = current?.kind === "broadcast" ? Radio : current?.kind === "host" ? Server : User
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="default" className="justify-between font-mono">
          <span className="flex items-center gap-2 truncate">
            <Icon className="size-3.5 text-muted-foreground" />
            {value}
          </span>
          <ChevronDown className="size-3.5 opacity-60" />
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-[31rem] p-0">
        <div className="border-b border-border/60 p-1.5">
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter recipients…" className="h-7 font-mono text-xs" autoFocus />
        </div>
        <div className="max-h-72 overflow-y-auto p-1">
          {list.map((t) => {
            const I = t.kind === "broadcast" ? Radio : t.kind === "host" ? Server : User
            return (
              <button
                key={t.value}
                onClick={() => {
                  onPick(t.value)
                  setOpen(false)
                }}
                className={cn(
                  "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-[13px] transition-colors hover:bg-accent/60",
                  value === t.value && "bg-accent",
                )}
              >
                <I className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="truncate font-mono text-xs">{t.label}</span>
              </button>
            )
          })}
        </div>
      </PopoverContent>
    </Popover>
  )
}
