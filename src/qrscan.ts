/**
 * QR scanning (M-J): capability detection + a camera decode session.
 *
 * The app shows QR codes for share codes and friend invites, and now
 * reads them back too. Decoding uses the platform BarcodeDetector
 * (Chromium / Android WebView) over a getUserMedia stream — no new
 * dependency, and where either piece is missing the capability check
 * says so up front, so callers can point at the paste box instead of
 * offering a dead button.
 *
 * A decoded code is just text: callers feed it to the very same
 * parsers the paste path uses (parseSharePayload / parseFriendInvite).
 * This module deliberately knows nothing about payload shapes.
 */

/** One detected barcode (the slice of the API we use). */
interface DetectedBarcode {
  rawValue?: string
}

interface BarcodeDetectorLike {
  detect: (source: HTMLVideoElement) => Promise<DetectedBarcode[]>
}

interface BarcodeDetectorCtor {
  new (options?: { formats?: string[] }): BarcodeDetectorLike
}

export interface ScanCapability {
  ok: boolean
  /** Plain-language reason when ok is false. */
  reason?: string
}

/** The environment facts the capability decision is made from. */
export interface ScanEnvironment {
  barcodeDetector: unknown
  getUserMedia: unknown
  isSecureContext: boolean
}

/**
 * Pure capability decision (unit-tested): scanning needs a
 * BarcodeDetector, a camera entry point, and a secure context
 * (getUserMedia is unavailable outside one). The app's Capacitor
 * origin is https://localhost, which is secure; a plain-http page in
 * a desktop browser is the usual way to land in the third case.
 */
export function scanCapability(env: ScanEnvironment): ScanCapability {
  if (typeof env.barcodeDetector !== 'function') {
    return {
      ok: false,
      reason: "This device's browser can't read QR codes inside the app.",
    }
  }
  if (typeof env.getUserMedia !== 'function') {
    return { ok: false, reason: 'No camera is available to the app on this device.' }
  }
  if (!env.isSecureContext) {
    return {
      ok: false,
      reason: 'The camera only works when the app runs in its secure view.',
    }
  }
  return { ok: true }
}

/** Capability of the environment this code is actually running in. */
export function currentScanCapability(): ScanCapability {
  if (typeof window === 'undefined') {
    return { ok: false, reason: "This device's browser can't read QR codes inside the app." }
  }
  const w = window as unknown as {
    BarcodeDetector?: unknown
    isSecureContext?: boolean
  }
  return scanCapability({
    barcodeDetector: w.BarcodeDetector,
    getUserMedia:
      typeof navigator === 'undefined'
        ? undefined
        : navigator.mediaDevices?.getUserMedia,
    isSecureContext: w.isSecureContext === true,
  })
}

export interface QrScanSession {
  stop: () => void
}

/**
 * Start the camera into `video` and poll the detector until a QR code
 * decodes (onCode fires exactly once, then the session stops) or the
 * caller stops the session. Rejects when the camera can't be opened —
 * permission refused, no camera, insecure context; the caller turns
 * that into a plain-language note and the paste fallback.
 */
export async function startQrScan(
  video: HTMLVideoElement,
  onCode: (text: string) => void,
): Promise<QrScanSession> {
  const w = window as unknown as { BarcodeDetector?: BarcodeDetectorCtor }
  if (typeof w.BarcodeDetector !== 'function') {
    throw new Error("This device's browser can't read QR codes inside the app.")
  }
  const detector = new w.BarcodeDetector({ formats: ['qr_code'] })
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  })

  let stopped = false
  let timer: ReturnType<typeof setTimeout> | null = null

  const stop = () => {
    if (stopped) return
    stopped = true
    if (timer) clearTimeout(timer)
    for (const track of stream.getTracks()) track.stop()
    video.srcObject = null
  }

  video.srcObject = stream
  video.setAttribute('playsinline', 'true')
  try {
    await video.play()
  } catch {
    // Some WebViews refuse play() until the element is laid out; the
    // stream is attached either way and detect() works on the frames.
  }

  const tick = async () => {
    if (stopped) return
    try {
      const codes = await detector.detect(video)
      const hit = codes.find((c) => typeof c.rawValue === 'string' && c.rawValue !== '')
      if (hit?.rawValue) {
        const text = hit.rawValue
        stop()
        onCode(text)
        return
      }
    } catch {
      // A frame the detector can't read yet (camera warming up, video
      // not laid out) is normal — keep polling.
    }
    if (!stopped) timer = setTimeout(() => void tick(), 250)
  }
  void tick()

  return { stop }
}
