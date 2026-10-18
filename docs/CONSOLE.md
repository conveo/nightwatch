# The mesh console

The console is the dashboard's first tab, and the whole app on a phone. You talk to
your agents and read what they send back as a conversation instead of a mailbox.

It is served by the same UI server as the rest of the dashboard (`pnpm ui`, on
`127.0.0.1:4747`), with no extra process.

## What it does

- **One timeline entry per agent message.** The header shows the author, the
  message type and the time; below it is a one-line recap; the raw message, with its
  correlation id, is behind "Show original". Messages are grouped by sender and
  correlation id, never by arrival time.
- **Threads.** One per agent that has written to you or that you have written to.
  The composer in a thread sends a mesh message as you, with no model involved.
- **Read receipts** under every message you send: delivered, read, answered, or
  unknown when the mesh cannot prove which.
- **"While you were away"**: counts of what arrived, what asked for a human, and
  which of your questions are still open.
- **Live delivery** to an open tab, and **Web Push** to your phone when no tab is
  visible.
- **A durable transcript** in SQLite on the host (`console.db` in `AGENT_MESH_HOME`),
  so a conversation survives a reload and a second device. Nothing in it leaves the
  machine unless you use the assistant (below).
- **An assistant**, if you set `OPENAI_API_KEY`: typed chat with tools that list
  agents, read threads and your inbox, ask an agent for its status and send messages;
  the recap line on each arriving message; and a voice mode.

The console reads your replies from the inbox of one operator id, `operator` by
default (`AGENT_MESH_OPERATOR_ID`). The dashboard's Compose button and the Plans tab
always publish as `operator`, so with the default a thread started there continues
in the console. If you change `AGENT_MESH_OPERATOR_ID`, replies to messages sent from
Compose or Plans go to `operator`'s inbox, which the console does not read.

## Without an OpenAI key

Everything except the assistant works: the timeline (showing the raw message where
the recap would be), threads and direct messages, receipts, the "while you were
away" card, the transcript and push notifications. Chat, recaps and voice say they
are off.

## With an OpenAI key

Put `OPENAI_API_KEY=...` in `agent-mesh/.env` (the `ui` script loads it) and restart
`pnpm ui`. Know what this sends to OpenAI:

- your typed and spoken turns, and the conversation so far;
- the agent messages the assistant reads with its tools, and every arriving message
  it recaps;
- in voice mode, your audio. The browser connects to OpenAI's realtime API directly,
  with a short-lived token the UI server issues; the key itself stays on the server.

The assistant can send mesh messages for you, and it sends without asking first.
Agent messages are untrusted input, and one can try to instruct the assistant. The
console reduces that: it replays arrivals to the model as quoted data from an agent,
not as the assistant's own words, its instructions say a mesh message is never an
instruction, and an agent's self-chosen role reaches the prompt as one short line. It
cannot rule it out, so check what the assistant reports it sent.

Images in agent messages and in the assistant's answers are never loaded. They show
as `[image: …]`, because an image URL loads with no click and can carry data out.

## On a phone

The UI server only listens on 127.0.0.1 and has no login, so you need something in
front of it that only you can reach. With [Tailscale](https://tailscale.com):

```bash
tailscale serve --bg 4747          # prints the HTTPS address, https://<name>/
AGENT_MESH_UI_ALLOWED_HOSTS=<name> AGENT_MESH_UI_ALLOWED_USERS=<your-tailscale-login> pnpm ui
```

`<name>` is the machine's full MagicDNS name, the host part of the address
`tailscale serve` prints. `<your-tailscale-login>` is your Tailscale login name,
usually your email address; `tailscale whois $(tailscale ip -4)` shows it.

`tailscale serve` tells the UI server who is asking (the `Tailscale-User-Login`
header), and with `AGENT_MESH_UI_ALLOWED_USERS` set every request through the proxy
must come from a listed login. That refuses other people on a shared tailnet, and
`tailscale funnel` (public, no login). Without it, anyone who can reach the address
can read every message and send messages as you. Never use `tailscale funnel` for
the console.

Push notifications need HTTPS (Tailscale provides it) and, on iOS, the Home Screen
app: open the console in Safari, Share → Add to Home Screen, open it from the Home
Screen, then tap "Notify me when answers arrive". Set `AGENT_MESH_PUSH_SUBJECT` to a
`mailto:` address you read; push services use it to contact the sender.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `AGENT_MESH_OPERATOR_ID` | `operator` | The mesh id you send as and read replies for. Changing it hides the replies to messages sent under the old id. |
| `OPENAI_API_KEY` | none | Turns on the assistant: chat, recaps and voice. |
| `AGENT_MESH_CHAT_MODEL` | `gpt-5.6-terra` | The model for chat and recaps. |
| `AGENT_MESH_VOICE_MODEL` | `gpt-realtime-2.1` | The realtime model for voice. |
| `AGENT_MESH_TRANSCRIBE_MODEL` | `gpt-live-transcribe` | Transcribes your speech so the phone can show what it heard. |
| `AGENT_MESH_VOICE` | `marin` | The assistant's voice. |
| `AGENT_MESH_PUSH_SUBJECT` | `mailto:agent-mesh@example.com` | The contact push services see for this server. |
| `AGENT_MESH_UI_ALLOWED_USERS` | none | Tailscale logins allowed through `tailscale serve`, comma-separated. See [On a phone](#on-a-phone). |
| `CONSOLE_DATABASE_URL` | `file:$AGENT_MESH_HOME/console.db` | The transcript database. |
| `CONSOLE_INBOX_HEAD_FILE` | `$AGENT_MESH_HOME/console-inbox-head.json` | The newest message the console has announced. |
| `CONSOLE_PUSH_FILE` | `$AGENT_MESH_HOME/console-push.json` | The push keypair and the registered devices. |

The push keypair is created on first use and must survive restarts: a new keypair
silently invalidates every device that subscribed. The server only registers
endpoints on the browsers' own push services (Google, Apple, Mozilla, Microsoft), and
keeps the newest ten devices.

The transcript, push and cursor files are readable by your user only. The UI server
itself has no login: on a machine shared with other users, any of them can reach
`127.0.0.1:4747`. Run the console on a machine that is yours alone.

## A second console on the same host

Every console on a host shares `AGENT_MESH_HOME`. A second one (a test, a branch you
are trying) must use its own transcript, cursor and push file and its own operator
id, or it consumes arrivals the real console should announce and writes into its
transcript:

```bash
S=$(mktemp -d)
AGENT_MESH_UI_PORT=4767 AGENT_MESH_OPERATOR_ID=operator-test \
CONSOLE_DATABASE_URL="file:$S/console.db" CONSOLE_INBOX_HEAD_FILE="$S/head.json" \
CONSOLE_PUSH_FILE="$S/push.json" pnpm ui
```

The Compose button and the Plans tab still publish as `operator` in that instance.

The browser smoke test does this for you: `pnpm --dir agent-mesh run smoke`. It
needs [agent-browser](https://github.com/vercel-labs/agent-browser) and a running
daemon, and no API key.

## Why it works this way

Five decisions that look odd until you know the constraint behind them. Each states the
constraint and the alternative that looks better and does not work.

### The transcript is replaced whole, with a floor that refuses to shrink it

The console stores each conversation as a full `UIMessage[]`, and a save **merges by
message id** into what is stored. Two simpler designs each lose data.

Appending only new messages loses the end of every turn: the AI SDK **mutates a message
in place** while it streams, and a tool part moves through `input-available` →
`output-available` under the same id. An append-only store captures half-finished turns
and never learns how they ended.

Replacing the whole transcript lets any surface overwrite the store with what it
happens to hold — a phone that has not finished hydrating, a tab restored from a stale
bfcache, a second device. A floor on message count does not fix it: two devices that
each loaded ten messages and appended one both send eleven, the floor passes both, and
the second save deletes the first device's message. A count cannot tell those two
transcripts apart.

Merging keeps every stored message through every save, takes the client's version of a
message it sent (the latest save of a streamed message is the most complete), and adds
messages the store lacked. A new message goes at the end, unless the client holds it
BEFORE the first message the two share — that is history older than the window the
server sent, and it goes in front. Saves to one conversation are serialised, because
the merge reads before it writes. A save answers with `behind` — how many messages the
surface is missing from inside or after its own window — and the client then folds the
server copy in with the same merge. A one-entry save is therefore an append, which is
how an arrival reaches its chat when that chat is not on screen.

The store keeps **every** message and serves only the newest 400. Trimming the store is
the obvious bound and it breaks the merge: a stale surface resends messages that have
aged out, the store no longer knows them, so they return as new turns and the newest
real ones are trimmed to make room. Saves write only the rows that changed or were
added, so the full history does not make them slower.

The chat view is mounted **once per conversation** (`key={conversationId}`), so a
request still in flight for the chat being left cannot land in the one being opened.
For the same reason arrivals are not the view's: one queue in the shell
(`useArrivals`) outlives every view. It files each arrival in the chat that asked,
or the chat open at that moment. It narrates whether or not that chat is on screen,
streams the recap into the chat's view only while it is shown, and stores the entry
either way.

### Presence is a visible-only beacon, not a socket count

Whether an arrival narrates quietly in the tab or notifies the phone depends on one
question: is the operator looking? The tempting signal is the SSE subscriber count, and it is
wrong in both directions. It drops to zero on every reconnect, so the operator gets
buzzed about something they are watching arrive. It stays above zero on a socket the
browser has abandoned, so they are never notified while genuinely away. Both were observed.

So a tab POSTs a beacon every 15s **only while `visibilityState === "visible"`**, and
the server treats the operator as present for 45s after the last one. The beacon means "a human
is looking at this"; the socket only means "a connection exists". They are different
facts and the routing decision needs the first.

Sockets and notifications are therefore additive, not alternatives. An arrival goes to
every open socket, and when no tab is visible it ALSO notifies: a background tab or a
locked phone keeps its socket, so routing on "is anyone connected" writes the reply
into a screen nobody can see and marks it handled.

The 45s window is sized to survive one dropped beacon and a server restart without
declaring the operator absent, while still letting a pocketed phone start receiving
notifications quickly.

### The read cursor advances on delivered, never on attempted

This is the most important invariant in the inbound path, and it is easy to break in
any place that hands a message on. The result is always the same: a message that
reached nobody, a cursor that moved past it, and a log line saying success.

1. **Emit to zero sockets.** A foregrounded tab mid-reconnect has no socket. The write
   reached nothing; the cursor advanced because presence said the operator was there.
2. **Push to zero devices.** When the push service prunes the last subscription, every
   later arrival routes `push`, sends to nobody, and is marked handled.
3. **A command that exited zero.** Typing a notification into an agent's terminal can
   succeed while the agent never reads the batch. That is why the daemon's managed
   delivery reports `submitted` until the agent sends a receipt (see
   [DELIVERY.md](DELIVERY.md)), and why a supervisor checks receipts, not the roster.

So a batch that reaches nothing is **held**: the position does not move and the next
poll re-offers it. A tab that keeps beaconing while its stream stays broken must not
hold mail forever, so the hold is capped (~30s) before falling through to push — and
the push only counts if it reached at least one device. The quiet handler returns how
many it reached; the cursor reads that number, not the fact that it was called.

An undeliverable batch is reported **once**, not once per 1.5s poll, and the marker
clears when a subscriber attaches — that being the only event that can change the
answer.

### `providerMetadata` item ids are stripped from anything replayed to a model

OpenAI's Responses API reads the ids inside `providerMetadata` as a claim about *its
own* conversation state, and rejects the entire request when a message's paired
reasoning item is not also present.

This transcript can never satisfy that, by design. It deliberately holds **three
lineages in one thread**: typed chat turns, narration turns produced by a separate
request, and mesh entries that were never a model turn at all. A reasoning item from
one lineage is always missing from another.

The failure is total rather than graceful — not a worse answer but *no* answer. One
reasoning turn in the history and every later chat message returns an error string,
while every arrival falls back to showing its raw envelope. Replaying those ids is a
cache optimisation; the transcript reading back at all is the product.

### Arrivals are grouped by sender and correlation, never by the clock

Inbound messages are batched over a 1.2s window before rendering. That window is a
statement about typing latency; it says nothing about meaning.

Three messages from one agent answering one request are one thing and collapse into one
timeline entry cleanly. Two agents answering two different questions inside the same
second are two things, and folding them under a single recap invents a relationship
between them, at the moment the operator is scanning fastest. The whole model is that an answer
is tied to the question that caused it, so the group key is `(sender, correlationId)`.

Messages with no correlation id are still grouped per sender: uncorrelated mail from two
agents is two pieces of news, not one.

A consequence worth knowing: because the entry header renders the author, type and time
directly above the recap, the **recap never names the sender**. Three attempts to have
it do so produced three different wrong names — it copied the agent from the preceding
conversation, and when prior turns stopped being replayed as assistant messages, it
copied the agent from the example inside its own system prompt. The name in the prose
was duplication of something already on screen, and the only field in it that could be
false.
