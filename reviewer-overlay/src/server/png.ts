const DATA_URL_PREFIX = "data:image/png;base64,"
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const MAX_SIDE_PX = 16_384

export type DecodedPng =
  | { ok: true; buffer: Buffer; width: number; height: number }
  | { ok: false; reason: string }

// Accepts only a base64 PNG data URL whose bytes start with a PNG signature and
// an IHDR chunk with sane dimensions. `Buffer.from(..., "base64")` silently
// skips characters outside the alphabet, so the payload is checked first.
export function decodePngDataUrl(dataUrl: string): DecodedPng {
  if (!dataUrl.startsWith(DATA_URL_PREFIX)) {
    return { ok: false, reason: "screenshot must be a data:image/png;base64 URL" }
  }
  const payload = dataUrl.slice(DATA_URL_PREFIX.length)
  if (payload.length === 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(payload)) {
    return { ok: false, reason: "screenshot is not valid base64" }
  }
  const buffer = Buffer.from(payload, "base64")
  if (buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    return { ok: false, reason: "screenshot is not a PNG" }
  }
  if (buffer.subarray(12, 16).toString("latin1") !== "IHDR") {
    return { ok: false, reason: "screenshot PNG has no IHDR chunk" }
  }
  const width = buffer.readUInt32BE(16)
  const height = buffer.readUInt32BE(20)
  if (width < 1 || height < 1 || width > MAX_SIDE_PX || height > MAX_SIDE_PX) {
    return { ok: false, reason: "screenshot dimensions are out of range" }
  }
  return { ok: true, buffer, width, height }
}
