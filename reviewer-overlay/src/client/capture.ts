// Viewport capture through a tab-sharing stream (getDisplayMedia). It is
// pixel-exact across cross-origin images and web fonts, which DOM
// serialisation is not, at the cost of one share prompt per comment session.
//
// The stream is requested when comment mode opens, not on the first send:
// Chrome's "sharing this tab" bar resizes the viewport when it appears, and a
// pin dropped before that would land on the wrong content.

export type CustomCapture = () => Promise<string | null>

export type CaptureMode = "display-media" | "none" | CustomCapture

const nextFrame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))

export async function settle(): Promise<void> {
  await nextFrame()
  await nextFrame()
}

// While the overlay is hidden for a capture, a small magenta square shows in
// the top-left corner. A frame counts as taken after the hide only when the
// square is in it. Waiting a fixed time is not enough: under load the capture
// stream lags the page by more than any fixed wait, and
// requestVideoFrameCallback stops firing for a video element that is not in
// the document. The square is painted over before the frame is annotated.
export const SENTINEL_PX = 8
export const SENTINEL_COLOR = "#ff00ff"
const FRESH_FRAME_TIMEOUT_MS = 2_000
const FRAME_POLL_MS = 40

function sentinelVisible(args: { ctx: CanvasRenderingContext2D; scale: number }): boolean {
  const at = Math.max(1, Math.floor((SENTINEL_PX / 2) * args.scale))
  const [r = 0, g = 0, b = 0] = args.ctx.getImageData(at, at, 1, 1).data
  // Wide tolerance: the capture converts to YUV and may scale the frame.
  return r > 180 && g < 100 && b > 180
}

function paintOverSentinel(args: { ctx: CanvasRenderingContext2D; scale: number }): void {
  const size = Math.ceil(SENTINEL_PX * args.scale) + 2
  const [r = 0, g = 0, b = 0] = args.ctx.getImageData(size + 1, size + 1, 1, 1).data
  args.ctx.fillStyle = `rgb(${r},${g},${b})`
  args.ctx.fillRect(0, 0, size, size)
}

export type GrabbedFrame = { canvas: HTMLCanvasElement; fresh: boolean }

type StartResult = { ok: true } | { ok: false; reason: string }

// A share prompt that is never answered leaves getDisplayMedia pending, so a
// send waits this long for it and then goes out without a screenshot.
const SHARE_PROMPT_TIMEOUT_MS = 10_000

export class DisplayMediaCapture {
  private stream: MediaStream | null = null
  private video: HTMLVideoElement | null = null
  private starting: Promise<StartResult> | null = null

  isLive(): boolean {
    return this.stream?.getVideoTracks().some((track) => track.readyState === "live") === true
  }

  // Must run inside a user gesture (a click), or the browser rejects it. A
  // second call while the prompt is open shares the first request.
  start(): Promise<StartResult> {
    if (this.isLive()) {
      return Promise.resolve({ ok: true })
    }
    if (this.starting == null) {
      this.starting = this.request().finally(() => {
        this.starting = null
      })
    }
    return this.starting
  }

  // Like start(), but gives up after SHARE_PROMPT_TIMEOUT_MS.
  startWithTimeout(): Promise<StartResult> {
    return new Promise((resolve) => {
      const timer = window.setTimeout(
        () => resolve({ ok: false, reason: "the share prompt was not answered" }),
        SHARE_PROMPT_TIMEOUT_MS,
      )
      void this.start().then((result) => {
        window.clearTimeout(timer)
        resolve(result)
      })
    })
  }

  private async request(): Promise<StartResult> {
    const media = navigator.mediaDevices as MediaDevices | undefined
    if (media?.getDisplayMedia == null) {
      return { ok: false, reason: "This browser cannot share a tab here (needs a secure context such as localhost)." }
    }
    const dpr = window.devicePixelRatio || 1
    try {
      const stream = await media.getDisplayMedia({
        video: {
          width: { ideal: Math.round(window.innerWidth * dpr) },
          height: { ideal: Math.round(window.innerHeight * dpr) },
          frameRate: { ideal: 30 },
        },
        audio: false,
        // Chromium-only hints that pre-select the current tab.
        ...({ preferCurrentTab: true, selfBrowserSurface: "include", displaySurface: "browser" } as object),
      })
      const video = document.createElement("video")
      video.muted = true
      video.playsInline = true
      video.srcObject = stream
      await video.play()
      this.stream = stream
      this.video = video
      stream.getVideoTracks()[0]?.addEventListener("ended", () => this.stop())
      return { ok: true }
    } catch (error) {
      return { ok: false, reason: error instanceof Error ? error.message : String(error) }
    }
  }

  // Grabs one frame with the overlay hidden. `hide` must hide the overlay and
  // show the sentinel square; `show` reverses both. `fresh` is false when no
  // frame with the sentinel arrived in time, so the overlay may be in it.
  async grab(args: { hide: () => void; show: () => void }): Promise<GrabbedFrame | null> {
    const video = this.video
    if (video == null || !this.isLive()) {
      return null
    }
    args.hide()
    try {
      await settle()
      const deadline = performance.now() + FRESH_FRAME_TIMEOUT_MS
      while (true) {
        const canvas = document.createElement("canvas")
        canvas.width = video.videoWidth
        canvas.height = video.videoHeight
        const ctx = canvas.getContext("2d", { willReadFrequently: true })
        if (ctx == null || canvas.width === 0 || canvas.height === 0) {
          return null
        }
        ctx.drawImage(video, 0, 0)
        const scale = canvas.width / window.innerWidth
        if (sentinelVisible({ ctx, scale })) {
          paintOverSentinel({ ctx, scale })
          return { canvas, fresh: true }
        }
        if (performance.now() > deadline) {
          return { canvas, fresh: false }
        }
        await new Promise((resolve) => window.setTimeout(resolve, FRAME_POLL_MS))
      }
    } finally {
      args.show()
    }
  }

  stop(): void {
    for (const track of this.stream?.getTracks() ?? []) {
      track.stop()
    }
    if (this.video != null) {
      this.video.srcObject = null
    }
    this.stream = null
    this.video = null
  }
}

export async function grabCustom(args: {
  capture: CustomCapture
  hide: () => void
  show: () => void
}): Promise<GrabbedFrame | null> {
  args.hide()
  let dataUrl: string | null
  try {
    await settle()
    dataUrl = await args.capture()
  } catch {
    dataUrl = null
  } finally {
    args.show()
  }
  if (dataUrl == null) {
    return null
  }
  const image = new Image()
  image.src = dataUrl
  try {
    await image.decode()
  } catch {
    return null
  }
  const canvas = document.createElement("canvas")
  canvas.width = image.naturalWidth
  canvas.height = image.naturalHeight
  const ctx = canvas.getContext("2d")
  if (ctx == null || canvas.width === 0) {
    return null
  }
  ctx.drawImage(image, 0, 0)
  return { canvas, fresh: true }
}
