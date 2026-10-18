// Constants shared by the browser client and the server. This module must not
// import zod (or anything else): the client bundle imports it, and the bundle
// stays dependency-free.

// Text limits match the ui-review note contract in the human-review skill.
export const MAX_COMMENT_CHARS = 4000
export const MAX_URL_CHARS = 4096
export const MAX_META_TEXT_CHARS = 512
export const MAX_CAPTURED_AT_CHARS = 40

// Strokes travel inside the mesh body, and the body reaches `agent-mesh publish`
// as ONE argv string. Linux caps a single argument at 128 KiB (MAX_ARG_STRLEN),
// and spawning fails with E2BIG above it. 2,000 points at ~26 bytes each plus
// the worst-case escaped comment, url and meta stay under MAX_MESH_BODY_BYTES.
// Raising these needs a different transport than argv, not a bigger number.
export const MAX_STROKES = 32
export const MAX_POINTS_PER_STROKE = 1000
export const MAX_TOTAL_POINTS = 2000
export const MAX_MESH_BODY_BYTES = 120_000

export const MESSAGE_TYPE = "note"
export const CORRELATION_ID = "ui-review"
export const BODY_KIND = "ui-review-comment"

export const AGENT_ID_PATTERN = /^[A-Za-z0-9._-]{1,128}$/
