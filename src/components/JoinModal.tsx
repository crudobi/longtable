import { useState } from 'react'
import { joinShare, parseSharePayload } from '../p2p/share'
import { friendlyError } from '../friendlyError'
import { currentScanCapability } from '../qrscan'
import { QrScannerModal } from './QrScannerModal'

interface Props {
  onJoined: () => void
  onClose: () => void
}

export function JoinModal({ onJoined, onClose }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [scannerOpen, setScannerOpen] = useState(false)
  const scan = currentScanCapability()

  const join = async (text?: string) => {
    setError(null)
    setBusy(true)
    try {
      // Scanned or pasted, the text takes the exact same parse path.
      const payload = parseSharePayload(text ?? code)
      await joinShare(payload)
      onJoined()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="join-modal">
      <div className="modal" role="dialog" aria-label="Join shared recipe">
        <h2>Join a shared recipe</h2>
        <p className="muted">
          Paste the share code your friend sent you. The recipe will appear in
          your list once your devices connect.
        </p>
        <textarea
          rows={4}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          placeholder='{"v":1,"room":"longtable-share-…"}'
          data-testid="join-code"
          aria-label="Share code"
        />
        {scan.ok ? (
          <button data-testid="join-scan" disabled={busy} onClick={() => setScannerOpen(true)}>
            Scan a code instead
          </button>
        ) : (
          <p className="muted" data-testid="join-scan-unavailable">
            {scan.reason} Pasting the code still works.
          </p>
        )}
        {error && (
          <p className="status error" data-testid="join-error">
            {error}
          </p>
        )}
        <div className="modal-actions">
          <button
            className="primary"
            data-testid="join-confirm"
            disabled={busy || !code.trim()}
            onClick={() => void join()}
          >
            {busy ? 'Joining…' : 'Join'}
          </button>
          <button className="ghost" data-testid="close-join" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
      {scannerOpen && (
        <QrScannerModal
          title="Scan a share code"
          onClose={() => setScannerOpen(false)}
          onScanned={(text) => {
            setScannerOpen(false)
            setCode(text)
            void join(text)
          }}
        />
      )}
    </div>
  )
}
