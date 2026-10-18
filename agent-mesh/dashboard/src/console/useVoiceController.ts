// Voice session ownership, shared by the phone shell and the desktop console.
//
// It lives above the views on purpose. The model uses `open_thread` to move the
// screen mid-sentence, and on the phone that is a full navigation — a session owned
// by the view the operator happened to be looking at when they started talking would be
// torn down by the model's own tool call. Hoisting it also means one implementation
// serves both widths instead of two that drift.

import type { UIMessage } from "ai"
import { useCallback, useRef, useState } from "react"

export type VoiceController = {
  /** Non-null while a session is wanted; the VoiceSession component renders off this. */
  session: { stream: MediaStream; instructions: string } | null
  messages: UIMessage[]
  setMessages: (messages: UIMessage[]) => void
  micError: string | null
  start: (instructions: string) => void
  stop: () => void
  /**
   * Set by whichever view owns the typed conversation. On stop, the spoken turns are
   * handed to it so they land in that thread — a conversation that erases itself when
   * you put the phone down is the part you most want to re-read, and it is also what
   * the typed model reads as context on the next turn.
   */
  adoptRef: React.MutableRefObject<((spoken: UIMessage[]) => void) | null>
}

export function useVoiceController(): VoiceController {
  const [session, setSession] = useState<{ stream: MediaStream; instructions: string } | null>(null)
  const [messages, setMessages] = useState<UIMessage[]>([])
  const [micError, setMicError] = useState<string | null>(null)
  const adoptRef = useRef<((spoken: UIMessage[]) => void) | null>(null)

  const start = useCallback((instructions: string) => {
    setMicError(null)
    // getUserMedia is started from inside the click/tap so Safari treats it as
    // gestured; deferring it until after the token round-trip loses that and the
    // permission prompt never appears.
    navigator.mediaDevices.getUserMedia({ audio: true }).then(
      (stream) => {
        setMessages([])
        setSession({ stream, instructions })
      },
      (e: Error) => setMicError(e.message),
    )
  }, [])

  const stop = useCallback(() => {
    setSession(null)
    setMessages((spoken) => {
      if (spoken.length > 0) {
        adoptRef.current?.(spoken)
      }
      return []
    })
  }, [])

  return { session, messages, setMessages, micError, start, stop, adoptRef }
}
