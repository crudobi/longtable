import { useState } from 'react'
import type { Identity } from '../identity/identity'
import { listFriends } from '../friends/friends'
import { getRecipeKey } from '../friends/shelf'
import { shareRecipeWithFriends } from '../friends/service'

interface Props {
  recipeId: string
  recipeTitle: string
  identity: Identity
  onClose: () => void
  onDone: () => void
}

function shortDid(did: string): string {
  return did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did
}

export function FriendShareModal({ recipeId, recipeTitle, identity, onClose, onDone }: Props) {
  const friends = listFriends()
  const [checked, setChecked] = useState<Set<string>>(
    () => new Set(getRecipeKey(recipeId)?.friends ?? []),
  )
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggle = (did: string) => {
    setChecked((prev) => {
      const next = new Set(prev)
      if (next.has(did)) next.delete(did)
      else next.add(did)
      return next
    })
  }

  const confirm = async () => {
    setBusy(true)
    setError(null)
    try {
      await shareRecipeWithFriends(recipeId, [...checked], identity)
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="friend-share-modal">
      <div className="modal" role="dialog" aria-label="Share with friends">
        <h2>Share “{recipeTitle}” with friends</h2>
        <p className="muted">
          The recipe is encrypted on this device; only the friends you pick
          receive a key. Unchecking a friend re-keys the recipe so they stop
          receiving updates.
        </p>
        {friends.length === 0 ? (
          <p className="empty" data-testid="friend-share-empty">
            You have no friends yet — add one from the Friends panel first.
          </p>
        ) : (
          <ul className="friend-list">
            {friends.map((f) => (
              <li key={f.did} className="friend-item">
                <label className="friend-check">
                  <input
                    type="checkbox"
                    data-testid="friend-check"
                    checked={checked.has(f.did)}
                    onChange={() => toggle(f.did)}
                  />
                  <span className="friend-name-text">{f.name || shortDid(f.did)}</span>
                </label>
              </li>
            ))}
          </ul>
        )}
        {error && (
          <p className="status error" data-testid="friend-share-error">{error}</p>
        )}
        <div className="modal-actions">
          <button
            className="primary"
            data-testid="share-friends-confirm"
            disabled={busy || friends.length === 0}
            onClick={() => void confirm()}
          >
            {busy ? 'Encrypting…' : 'Share encrypted'}
          </button>
          <button className="ghost" data-testid="close-friend-share" onClick={onClose}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  )
}
