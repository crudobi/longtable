import { useState } from 'react'
import { joinShare, parseSharePayload } from '../p2p/share'

interface Props {
  onJoined: () => void
  onClose: () => void
}

export function JoinModal({ onJoined, onClose }: Props) {
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const join = async () => {
    setError(null)
    setBusy(true)
    try {
      const payload = parseSharePayload(code)
      await joinShare(payload)
      onJoined()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
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
    </div>
  )
}
