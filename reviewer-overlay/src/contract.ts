import { z } from "zod"
import {
  AGENT_ID_PATTERN,
  BODY_KIND,
  CORRELATION_ID,
  MAX_CAPTURED_AT_CHARS,
  MAX_COMMENT_CHARS,
  MAX_META_TEXT_CHARS,
  MAX_POINTS_PER_STROKE,
  MAX_STROKES,
  MAX_TOTAL_POINTS,
  MAX_URL_CHARS,
} from "./limits.ts"

export * from "./limits.ts"

// Same charset agent-mesh enforces for ids; the id becomes part of a Redis key.
export const agentIdSchema = z.string().regex(AGENT_ID_PATTERN)

// ---- test plan (untracked/review-plan.json) ----
// Every field is optional and unknown keys are kept, so a plan written for
// another tool that follows the human-review skill's schema renders unchanged.

const copyBlockSchema = z.looseObject({
  kind: z.string().optional(),
  label: z.string().optional(),
  text: z.string(),
})

const stepSchema = z.union([
  z.string(),
  z.looseObject({
    text: z.string(),
    copy: z.array(copyBlockSchema).optional(),
  }),
])

const featureSchema = z.looseObject({
  id: z.string().optional(),
  title: z.string().optional(),
  badge: z.string().optional(),
  ticket: z.string().optional(),
  tag: z.string().optional(),
  url: z.string().optional(),
  intro: z.string().optional(),
  steps: z.array(stepSchema).optional(),
  pass: z.string().optional(),
  note: z.string().optional(),
})

export const planSchema = z.looseObject({
  title: z.string().optional(),
  subtitle: z.string().optional(),
  appBase: z.string().optional(),
  features: z.array(featureSchema).optional(),
  // A flat `{ steps }` plan renders as a single feature.
  steps: z.array(stepSchema).optional(),
})

export type CopyBlock = z.infer<typeof copyBlockSchema>
export type Step = z.infer<typeof stepSchema>
export type Feature = z.infer<typeof featureSchema>
export type Plan = z.infer<typeof planSchema>

// ---- review request (browser -> local server) ----

const pinSchema = z.object({
  n: z.number().int().min(0).max(100_000),
  xPct: z.number(),
  yPct: z.number(),
  pageX: z.number(),
  pageY: z.number(),
})

const metaSchema = z.object({
  title: z.string().max(MAX_META_TEXT_CHARS),
  viewport: z.object({ w: z.number(), h: z.number(), dpr: z.number() }),
  userAgent: z.string().max(MAX_META_TEXT_CHARS),
})

const strokeSchema = z.object({
  points: z
    .array(
      z.object({
        xPct: z.number().min(0).max(100),
        yPct: z.number().min(0).max(100),
      }),
    )
    .max(MAX_POINTS_PER_STROKE),
})

export const reviewRequestSchema = z
  .object({
    // Empty is allowed so a pin- or drawing-only review can be sent.
    comment: z.string().max(MAX_COMMENT_CHARS),
    url: z.string().max(MAX_URL_CHARS),
    pin: pinSchema.nullable(),
    meta: metaSchema.nullable(),
    // The data URL is bounded by the server's request size cap, not here.
    screenshotDataUrl: z.string().nullable(),
    capturedAt: z.string().max(MAX_CAPTURED_AT_CHARS),
    targetAgentId: agentIdSchema.nullable().default(null),
    strokes: z.array(strokeSchema).max(MAX_STROKES).nullable().default(null),
  })
  .refine(
    (review) =>
      review.comment.trim() !== "" ||
      review.pin != null ||
      review.screenshotDataUrl != null ||
      (review.strokes != null && review.strokes.length > 0),
    { message: "Provide a comment, a pin, or a drawing." },
  )
  .refine(
    (review) =>
      review.strokes == null ||
      review.strokes.reduce((total, stroke) => total + stroke.points.length, 0) <=
        MAX_TOTAL_POINTS,
    { message: "The drawing contains too many points.", path: ["strokes"] },
  )
  .refine(
    (review) =>
      review.screenshotDataUrl == null ||
      review.strokes == null ||
      review.strokes.length === 0,
    {
      message: "Strokes are only sent when there is no screenshot.",
      path: ["strokes"],
    },
  )

export type ReviewRequest = z.input<typeof reviewRequestSchema>
export type ParsedReviewRequest = z.output<typeof reviewRequestSchema>
export type ReviewPin = z.infer<typeof pinSchema>
export type ReviewMeta = z.infer<typeof metaSchema>
export type ReviewStroke = z.infer<typeof strokeSchema>

// ---- mesh message body (local server -> agent) ----
// The ui-review note body described in the human-review skill. This tool has no
// remote storage and no sign-in, so `reporter`, `screenshotUrl`,
// `screenshotBucket` and `screenshotKey` are always null.

export type ReviewMessageBody = {
  kind: typeof BODY_KIND
  comment: string
  url: string
  pin: ReviewPin | null
  meta: ReviewMeta | null
  reporter: null
  strokes: ReviewStroke[] | null
  screenshot: string | null
  screenshotUrl: null
  screenshotBucket: null
  screenshotKey: null
  capturedAt: string
  note: string
}

export function buildMessageBody(args: {
  review: ParsedReviewRequest
  screenshotPath: string | null
  reporterId: string
}): ReviewMessageBody {
  const { review } = args
  return {
    kind: BODY_KIND,
    comment: review.comment,
    url: review.url,
    pin: review.pin,
    meta: review.meta,
    reporter: null,
    strokes: review.strokes,
    screenshot: args.screenshotPath,
    screenshotUrl: null,
    screenshotBucket: null,
    screenshotKey: null,
    capturedAt: review.capturedAt,
    note: `Reviewer overlay feedback. The screenshot is a PNG of the viewport at \`screenshot\` (an absolute path on the reviewer's machine; null when capture failed). The numbered pin in it marks the spot the comment is about (\`pin.xPct\`/\`pin.yPct\` = % across/down the viewport). \`strokes\` are freehand annotations in % coordinates, sent only when there is no screenshot. \`url\` is the page, \`meta\` has the title and viewport size. \`reporter\`, \`screenshotUrl\`, \`screenshotBucket\` and \`screenshotKey\` are always null here. Reply with \`agent-mesh publish --to ${args.reporterId} --type note --corr ${CORRELATION_ID} --reply <this message's stream id>\`.`,
  }
}

// ---- server responses ----

export type ReviewConfigResponse = {
  enabled: true
  canChooseTarget: boolean
  targetAgentId: string
  plan: Plan | null
  planError: string | null
}

export type ReviewPostResponse =
  | {
      ok: true
      delivered: true
      meshMessageId: string
      targetAgentId: string
      screenshotPath: string | null
      reportPath: string
    }
  | {
      ok: false
      error: string
      message: string
      screenshotPath: string | null
      reportPath: string | null
    }
