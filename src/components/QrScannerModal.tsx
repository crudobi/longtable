import { useEffect, useRef, useState } from 'react'
import { startQrScan, type QrScanSession } from '../qrscan'
import { friendlyError } from '../friendlyError'

interface Props {
  /** Heading text, e.g. "Scan a share code". */
  title: string
  /** A code was decoded. The text is unvalidated — the caller parses it
   *  through exactly the same path as pasted text. */
  onScanned: (text: string) => void
  onClose: () => void
}

/** Turn a camera-open failure into a plain sentence with the way out. */
function cameraFailure(e: unknown): string {
  if (e instanceof DOMException && e.name === 'NotAllowedError') {
    return "Camera permission was refused. You can allow it in the app's system settings — or close this and paste the code instead."
  }
  if (e instanceof DOMException && (e.name === 'NotFoundError' || e.name === 'OverconstrainedError')) {
    return 'No camera was found on this device. Close this and paste the code instead.'
  }
  return `${friendlyError(e)} Close this and paste the code instead.`
}

/**
 * Full-screen camera scanner: live video, decode loop from qrscan.ts,
 * stop-on-close and stop-on-decode. The stream never outlives the
 * modal — the cleanup stops every track.
 */
export function QrScannerModal({ title, onScanned, onClose }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null)
  const scannedRef = useRef(onScanned)
  scannedRef.current = onScanned
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let session: QrScanSession | null = null
    let cancelled = false
    const video = videoRef.current
    if (!video) return
    startQrScan(video, (text) => {
      if (!cancelled) scannedRef.current(text)
    })
      .then((s) => {
        if (cancelled) s.stop()
        else session = s
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(cameraFailure(e))
      })
    return () => {
      cancelled = true
      session?.stop()
    }
  }, [])

  return (
    <div className="modal-backdrop" data-testid="qr-scanner">
      <div className="modal" role="dialog" aria-label={title}>
        <h2>{title}</h2>
        <video
          ref={videoRef}
          className="qr-video"
          data-testid="qr-video"
          autoPlay
          muted
          playsInline
        />
        {error ? (
          <p className="status error" data-testid="qr-scan-error">
            {error}
          </p>
        ) : (
          <p className="muted">Point the camera at the code — it reads itself.</p>
        )}
        <div className="modal-actions">
          <button className="ghost" data-testid="qr-scan-close" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
