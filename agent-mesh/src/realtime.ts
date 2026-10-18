// Voice mode for the mobile console — the server half.
//
// The browser runs the AI SDK's `experimental_useRealtime`, which POSTs its desired
// `sessionConfig` to this endpoint and expects back `{ token, url, tools }` (the
// SDK's `Experimental_RealtimeSetupResponse`). We mint the ephemeral credential
// here, so the raw OPENAI_API_KEY never leaves this process; the phone gets an
// `ek_…` that OpenAI scopes to one session and expires in minutes, and it opens
// the websocket to OpenAI directly — audio never transits this box.
//
// The tool DEFINITIONS come back from here too, derived from the very same
// `meshTools()` the typed assistant runs. That is deliberate: a voice session that
// knew a different set of tools than the chat would be a second product with its
// own bugs.

import { createOpenAI } from "@ai-sdk/openai"
import { experimental_getRealtimeToolDefinitions, type Experimental_RealtimeSessionConfig } from "ai"
import { meshTools } from "./mesh-console.js"

// GA speech-to-speech model. The `-mini` sibling is cheaper, but this is one
// person talking to a handful of agents about work that matters — pick the
// accurate one. Override with AGENT_MESH_VOICE_MODEL.
const DEFAULT_REALTIME_MODEL = "gpt-realtime-2.1"
// Streaming STT for the operator's own audio, so the phone can show what it heard.
const DEFAULT_TRANSCRIBE_MODEL = "gpt-live-transcribe"
// `marin` and `cedar` are the realtime-native voices; the older TTS voices sound
// noticeably flatter over speech-to-speech.
const DEFAULT_VOICE = "marin"

// Long enough to survive a slow tailnet handshake, short enough that a secret
// left behind in the phone's memory is worthless by the time anyone finds it.
const SECRET_TTL_SECONDS = 600

export function voiceKey(): string | null {
  const key = process.env.OPENAI_API_KEY
  return key != null && key.trim() !== "" ? key.trim() : null
}

export function voiceConfig(): { available: boolean; model: string; transcribeModel: string; voice: string } {
  return {
    available: voiceKey() != null,
    model: process.env.AGENT_MESH_VOICE_MODEL ?? DEFAULT_REALTIME_MODEL,
    transcribeModel: process.env.AGENT_MESH_TRANSCRIBE_MODEL ?? DEFAULT_TRANSCRIBE_MODEL,
    voice: process.env.AGENT_MESH_VOICE ?? DEFAULT_VOICE,
  }
}

export type SetupResult = { status: number; body: string }

/**
 * Mint one realtime session. `sessionConfig` is whatever the browser asked for
 * (instructions built from the live roster, VAD tuning, voice); it is echoed into
 * the token request and the SDK re-applies it over the socket on open.
 *
 * OpenAI's own error body is relayed on failure: a voice button that just says
 * "failed" on a phone, with no devtools in reach, is undebuggable.
 */
export async function realtimeSetup(args: { me: string; sessionConfig: Partial<Experimental_RealtimeSessionConfig> | null }): Promise<SetupResult> {
  const apiKey = voiceKey()
  if (apiKey == null) {
    return {
      status: 503,
      body: JSON.stringify({ error: "OPENAI_API_KEY is not set — set OPENAI_API_KEY in the ui-server's environment (for example in agent-mesh/.env) to enable voice." }),
    }
  }
  const cfg = voiceConfig()
  const openai = createOpenAI({ apiKey })
  const sessionConfig: Partial<Experimental_RealtimeSessionConfig> = {
    voice: cfg.voice,
    ...(args.sessionConfig ?? {}),
  }
  try {
    const tools = await experimental_getRealtimeToolDefinitions({ tools: meshTools({ me: args.me }) })
    const secret = await openai.experimental_realtime.getToken({
      model: cfg.model,
      expiresAfterSeconds: SECRET_TTL_SECONDS,
      sessionConfig: sessionConfig as Experimental_RealtimeSessionConfig,
    })
    // Only the ephemeral credential crosses back.
    return {
      status: 200,
      body: JSON.stringify({ token: secret.token, url: secret.url, expiresAt: secret.expiresAt ?? null, tools }),
    }
  } catch (e) {
    return { status: 502, body: JSON.stringify({ error: "could not mint a realtime session", detail: (e as Error).message.slice(0, 1200) }) }
  }
}
