// One agent's thread, polled while it is on screen. Shared by both shells so the
// poll interval and the drop-a-tick behaviour can't diverge between them.

import { useEffect, useState } from "react"
import type { MeshMessage } from "@/lib/api"
import { consoleApi } from "./console-api"
import { ThreadView } from "./ThreadView"

const THREAD_MS = 2500

export function LiveThread({ peer, me, onSent }: { peer: string; me: string; onSent: () => void }) {
  const [state, setState] = useState<{ messages: MeshMessage[]; sendOnly: boolean } | null>(null)

  useEffect(() => {
    let live = true
    setState(null)
    const load = () => {
      consoleApi.thread({ peer, me }).then(
        (t) => live && setState({ messages: t.messages, sendOnly: t.sendOnly }),
        // A dropped poll keeps the last-known thread on screen rather than flashing it
        // empty; the next good tick repopulates.
        () => undefined,
      )
    }
    load()
    const t = setInterval(() => {
      if (document.visibilityState === "visible") {
        load()
      }
    }, THREAD_MS)
    return () => {
      live = false
      clearInterval(t)
    }
  }, [peer, me])

  return (
    <ThreadView
      loading={state == null}
      me={me}
      messages={state?.messages ?? []}
      onSent={onSent}
      peer={peer}
      sendOnly={state?.sendOnly ?? false}
    />
  )
}
