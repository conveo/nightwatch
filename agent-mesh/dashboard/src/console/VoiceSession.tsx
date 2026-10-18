// The hands-free half of the console.
//
// This component is MOUNTED ONLY WHILE A VOICE SESSION IS WANTED, and that is
// load-bearing rather than tidy: `useRealtime` memoizes its session on the
// identity of `sessionConfig`, so a config rebuilt on any later render would
// silently tear down the live session mid-sentence. Mounting fresh per session
// means each one is built from the roster as it is right now and then frozen.

import { Experimental_OpenAIRealtimeModel } from "@ai-sdk/openai"
import { experimental_useRealtime } from "@ai-sdk/react"
import type { Experimental_RealtimeSessionConfig, UIMessage } from "ai"
import { Loader2, Mic, MicOff, Square, Volume2 } from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { consoleApi, type ConsoleConfig } from "./console-api"
import { cn } from "@/lib/utils"

type VoicePhase = "connecting" | "listening" | "speaking" | "error" | "closed"

type Props = {
  config: ConsoleConfig
  instructions: string
  /** Acquired in the tap handler, because iOS only grants the mic inside a gesture. */
  stream: MediaStream
  onMessages: (messages: UIMessage[]) => void
  onOpenThread: (agent: string) => void
  onStop: () => void
}

export function VoiceSession({ config, instructions, stream, onMessages, onOpenThread, onStop }: Props) {
  const [error, setError] = useState<string | null>(null)
  const [needsGesture, setNeedsGesture] = useState(false)

  // The browser half of the provider never needs a real credential: it only
  // serializes events and derives the websocket subprotocol. The ephemeral token
  // comes from /api/console/realtime-session, which is where the real key lives.
  const model = useMemo(
    () =>
      new Experimental_OpenAIRealtimeModel(config.voice.model, {
        provider: "openai.realtime",
        baseURL: "https://api.openai.com/v1",
        headers: () => ({}),
      }),
    [config.voice.model],
  )

  // Frozen for the life of this mount — see the header.
  const [sessionConfig] = useState<Partial<Experimental_RealtimeSessionConfig>>(() => ({
    instructions,
    voice: config.voice.voice,
    outputModalities: ["audio"],
    // Semantic VAD reads intent rather than silence, which is what makes this
    // usable outdoors: a plain silence timer cuts the operator off every time they pause to
    // think, and raising the timer to compensate makes every reply feel late.
    turnDetection: { type: "semantic-vad" },
    inputAudioTranscription: { model: config.voice.transcribeModel },
  }))

  const realtime = experimental_useRealtime({
    model,
    api: { token: "/api/console/realtime-session" },
    sessionConfig,
    onToolCall: async ({ toolCall }) => {
      if (toolCall.toolName === "open_thread") {
        const agent = (toolCall.args as { agent?: string } | null)?.agent
        if (typeof agent === "string" && agent !== "") {
          onOpenThread(agent)
        }
      }
      return consoleApi.runTool(toolCall.toolName, toolCall.args)
    },
    onError: (e) => setError(e.message),
  })

  // Deliberately keyed on the mount alone, with a guard: one connection per
  // session. Adding `realtime` to the deps would reconnect on every store change
  // and OpenAI bills — and interrupts — per connection.
  const connectedRef = useRef(false)
  useEffect(() => {
    if (connectedRef.current) {
      return
    }
    connectedRef.current = true
    realtime
      .connect({ stream })
      // `connect` only STORES the supplied stream; capture and playback each need
      // their own resume, and without them the session comes up connected, silent
      // and deaf — the failure mode that looks exactly like a working session.
      .then(() => Promise.all([realtime.resumePlayback(), realtime.resumeAudioCapture()]))
      .catch((e: Error) => {
        // Safari only starts an AudioContext from inside a user gesture, and the
        // resumes above run a few microtasks after the tap that mounted this. When
        // that window has closed the bar offers an explicit tap instead of dying.
        setNeedsGesture(true)
        setError(e.message)
      })
    return () => {
      realtime.disconnect()
      for (const track of stream.getTracks()) {
        track.stop()
      }
    }
  }, [])

  useEffect(() => {
    onMessages(realtime.messages)
  }, [realtime.messages, onMessages])

  const unlock = () => {
    setError(null)
    setNeedsGesture(false)
    void Promise.all([realtime.resumePlayback(), realtime.resumeAudioCapture()]).catch((e: Error) => {
      setNeedsGesture(true)
      setError(e.message)
    })
  }

  const phase: VoicePhase =
    error != null || realtime.status === "error"
      ? "error"
      : realtime.status === "connecting"
        ? "connecting"
        : realtime.status === "disconnected"
          ? "closed"
          : realtime.isPlaying
            ? "speaking"
            : "listening"

  const label =
    phase === "error"
      ? (error ?? "voice failed")
      : phase === "connecting"
        ? "connecting…"
        : phase === "speaking"
          ? "speaking"
          : phase === "closed"
            ? "disconnected"
            : realtime.isCapturing
              ? "listening"
              : needsGesture
                ? "tap the mic to enable audio"
                : "mic muted — tap to resume"

  return (
    <div className="mesh-safe-bottom border-t border-border/70 bg-card/80 px-3 pt-3 backdrop-blur-xl">
      <div className="flex items-center gap-3">
        <button
          aria-label={realtime.isCapturing ? "Mute microphone" : "Unmute microphone"}
          className={cn(
            "grid size-12 shrink-0 place-items-center rounded-full",
            phase === "error" ? "bg-destructive/15 text-destructive" : "bg-primary/15 text-primary",
            phase === "listening" && realtime.isCapturing && "animate-meshbreathe",
            phase === "speaking" && "animate-meshbreathe-fast",
          )}
          onClick={() => (realtime.isCapturing ? realtime.stopAudioCapture() : unlock())}
          type="button"
        >
          {phase === "connecting" ? (
            <Loader2 className="size-5 animate-spin" />
          ) : phase === "speaking" ? (
            <Volume2 className="size-5" />
          ) : phase === "error" || phase === "closed" || !realtime.isCapturing ? (
            <MicOff className="size-5" />
          ) : (
            <Mic className="size-5" />
          )}
        </button>

        <div className="min-w-0 flex-1">
          <p className={cn("truncate text-sm font-medium", phase === "error" ? "text-destructive" : "text-foreground")}>{label}</p>
          <p className="truncate text-[11px] text-muted-foreground">
            {config.voice.model} · {config.voice.voice}
          </p>
        </div>

        {phase === "speaking" && (
          <button
            className="rounded-full border border-border px-3 py-2 text-xs text-muted-foreground active:bg-accent"
            onClick={() => realtime.cancelResponse()}
            type="button"
          >
            skip
          </button>
        )}
        <button
          aria-label="End voice session"
          className="grid size-12 shrink-0 place-items-center rounded-full bg-destructive/15 text-destructive active:bg-destructive/25"
          onClick={onStop}
          type="button"
        >
          <Square className="size-4 fill-current" />
        </button>
      </div>
    </div>
  )
}
