import { useCallback, useEffect, useRef, useState } from 'react'
import QRCode from 'react-qr-code'
import type { Identity } from '../identity/identity'
import {
  createFriendInvite,
  getFriend,
  joinFriendChannel,
  listFriends,
  parseFriendInvite,
  runPairing,
  type FriendInvitePayload,
  type FriendRecord,
} from '../friends/friends'
import {
  getDisplayName,
  importReceivedShares,
  listReceivedShares,
  setDisplayName,
  unfriendAndRekey,
  type ReceivedShareInfo,
} from '../friends/service'

interface Props {
  identity: Identity
  onClose: () => void
  onOpenRecipe: (localId: string) => void
  onChanged: () => void
}

function shortDid(did: string): string {
  return did.length > 24 ? `${did.slice(0, 16)}…${did.slice(-6)}` : did
}

export function FriendsPanel({ identity, onClose, onOpenRecipe, onChanged }: Props) {
  const [name, setName] = useState(() => getDisplayName() || '')
  const [friends, setFriends] = useState<FriendRecord[]>(() => listFriends())
  const [invite, setInvite] = useState<FriendInvitePayload | null>(null)
  const [joinCode, setJoinCode] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [received, setReceived] = useState<ReceivedShareInfo[]>([])
  const pairingRef = useRef(false)

  const reload = useCallback(async () => {
    setFriends(listFriends())
    setReceived(await listReceivedShares())
  }, [])

  useEffect(() => {
    void reload()
  }, [reload])

  const myName = name.trim() || 'A Longtable cook'

  // Show my invite and start listening for whoever scans it.
  const showInvite = useCallback(async () => {
    setError(null)
    const inv = await createFriendInvite(identity, myName)
    setInvite(inv)
    if (pairingRef.current) return
    pairingRef.current = true
    try {
      const rec = await runPairing(identity, myName, inv, null)
      setStatus(`You are now friends with ${rec.name || shortDid(rec.did)}.`)
      await joinFriendChannel(rec)
      await importReceivedShares(identity)
      await reload()
      onChanged()
    } catch (e) {
      // Timeout is normal if nobody scans; only surface real errors while
      // the panel is still open.
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      pairingRef.current = false
    }
  }, [identity, myName, reload, onChanged])

  const join = async () => {
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      const inv = parseFriendInvite(joinCode)
      setDisplayName(myName)
      const rec = await runPairing(identity, myName, inv, inv.did)
      setStatus(`You are now friends with ${rec.name || shortDid(rec.did)}.`)
      await joinFriendChannel(rec)
      const n = await importReceivedShares(identity)
      if (n > 0) setStatus((s) => `${s ?? ''} ${n} shared recipe(s) received.`)
      setJoinCode('')
      await reload()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const unfriend = async (friend: FriendRecord) => {
    if (!window.confirm(`Remove ${friend.name || shortDid(friend.did)} as a friend? Recipes you shared with them will be re-keyed so they stop receiving updates.`)) return
    setBusy(true)
    setError(null)
    try {
      await unfriendAndRekey(friend.did, identity)
      setStatus(`${friend.name || 'Friend'} removed and your recipes re-keyed.`)
      await reload()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="friends-panel">
      <div className="modal modal-wide" role="dialog" aria-label="Friends">
        <h2>Friends</h2>
        <p className="muted">
          Friends exchange recipes directly, encrypted so only the friends
          you choose can read them. No accounts — pairing is by code, like
          everything else in Longtable.
        </p>

        <label className="field-label" htmlFor="friend-name">Your name (shown to friends)</label>
        <input
          id="friend-name"
          data-testid="friend-name"
          value={name}
          onChange={(e) => {
            setName(e.target.value)
            setDisplayName(e.target.value)
          }}
          placeholder="e.g. Alex"
        />
        <p className="muted" data-testid="friend-my-did">
          Your ID: {shortDid(identity.did)}
        </p>

        <h3>Add a friend</h3>
        {!invite ? (
          <button data-testid="friend-show-invite" onClick={() => void showInvite()}>
            Show my invite code
          </button>
        ) : (
          <>
            <div className="qr-wrap">
              <QRCode value={JSON.stringify(invite)} size={200} data-testid="friend-invite-qr" />
            </div>
            <p className="muted">Your friend pastes this code in their Friends panel. Waiting for them…</p>
            <textarea
              readOnly
              rows={3}
              value={JSON.stringify(invite)}
              data-testid="friend-invite-code"
              aria-label="Friend invite code"
              onFocus={(e) => e.target.select()}
            />
          </>
        )}

        <label className="field-label" htmlFor="friend-join-code">…or paste a friend's invite code</label>
        <textarea
          id="friend-join-code"
          rows={3}
          value={joinCode}
          onChange={(e) => setJoinCode(e.target.value)}
          placeholder='{"v":2,"kind":"friend",…}'
          data-testid="friend-join-code"
          aria-label="Friend invite code to join"
        />
        <div className="modal-actions">
          <button
            className="primary"
            data-testid="friend-join-confirm"
            disabled={busy || !joinCode.trim()}
            onClick={() => void join()}
          >
            {busy ? 'Pairing…' : 'Pair with this friend'}
          </button>
        </div>

        <h3>Your friends</h3>
        {friends.length === 0 ? (
          <p className="empty" data-testid="friend-empty">No friends yet.</p>
        ) : (
          <ul className="friend-list">
            {friends.map((f) => (
              <li key={f.did} className="friend-item" data-testid="friend-item">
                <span className="friend-name-text">{f.name || shortDid(f.did)}</span>
                <span className="muted">{shortDid(f.did)}</span>
                <button
                  className="danger"
                  data-testid="unfriend-friend"
                  disabled={busy}
                  onClick={() => void unfriend(f)}
                >
                  Unfriend
                </button>
              </li>
            ))}
          </ul>
        )}

        <h3>Shared with me</h3>
        {received.length === 0 ? (
          <p className="empty" data-testid="shelf-empty">
            Nothing yet — when a friend shares a recipe with you, it appears here.
          </p>
        ) : (
          <ul className="friend-list" data-testid="shelf-list">
            {received.map((r) => (
              <li key={`${r.ownerDid}:${r.recipeId}`} className="friend-item">
                <button
                  className="recipe-card"
                  data-testid="shelf-item"
                  onClick={() => {
                    onOpenRecipe(r.localId)
                    onClose()
                  }}
                >
                  <span className="recipe-card-title">{r.title}</span>
                  <span className="recipe-card-meta">
                    from {getFriend(r.ownerDid)?.name || r.ownerName || shortDid(r.ownerDid)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}

        {status && (
          <p className="status" data-testid="friend-status">{status}</p>
        )}
        {error && (
          <p className="status error" data-testid="friend-error">{error}</p>
        )}
        <div className="modal-actions">
          <button className="ghost" data-testid="close-friends" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
