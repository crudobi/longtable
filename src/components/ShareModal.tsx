import { useEffect, useState } from 'react'
import QRCode from 'react-qr-code'
import { peerCount } from '../p2p/share'
import type { SharePayload } from '../p2p/share'

interface Props {
  payload: SharePayload
  onClose: () => void
}

export function ShareModal({ payload, onClose }: Props) {
  const [peers, setPeers] = useState(0)
  const [copied, setCopied] = useState(false)
  const code = JSON.stringify(payload)

  useEffect(() => {
    const update = () => setPeers(peerCount(payload.room))
    update()
    const t = setInterval(update, 2000)
    return () => clearInterval(t)
  }, [payload.room])

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code)
    } catch {
      /* clipboard unavailable — the text is selectable below */
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 1500)
  }

  return (
    <div className="modal-backdrop" data-testid="share-modal">
      <div className="modal" role="dialog" aria-label="Share recipe">
        <h2>Share “{payload.title}”</h2>
        <p className="muted">
          Your friend scans this code (or pastes the text below) in Longtable
          to receive the recipe. Edits sync directly between your devices.
        </p>
        <div className="qr-wrap">
          <QRCode value={code} size={220} data-testid="share-qr" />
        </div>
        <p className="muted">
          {peers === 0
            ? 'Waiting for your friend to join…'
            : `${peers} friend${peers === 1 ? '' : 's'} connected`}
        </p>
        <textarea
          readOnly
          rows={4}
          value={code}
          data-testid="share-code"
          aria-label="Share code (copy and send manually)"
          onFocus={(e) => e.target.select()}
        />
        <div className="modal-actions">
          <button data-testid="copy-share-code" onClick={() => void copy()}>
            {copied ? 'Copied!' : 'Copy code'}
          </button>
          <button className="ghost" data-testid="close-share" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
