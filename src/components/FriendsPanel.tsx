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
  acceptManualOffer,
  completeManualOffer,
  createManualOffer,
  extractManualBlob,
  isManualSdpSupported,
  manualOfferLink,
  MANUAL_OFFER_HASH_PARAM,
  type ManualSdpSession,
} from '../friends/manualSdp'
import { getIceServers } from '../hubs/hubs'
import {
  getDisplayName,
  importReceivedShares,
  listReceivedShares,
  setDisplayName,
  unfriendAndRekey,
  type ReceivedShareInfo,
} from '../friends/service'
import { friendlyError } from '../friendlyError'
import { currentScanCapability } from '../qrscan'
import { QrScannerModal } from './QrScannerModal'

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
  const [scannerOpen, setScannerOpen] = useState(false)
  const scan = currentScanCapability()
  const pairingRef = useRef(false)

  // Manual-SDP fallback (E3): pair with no hub in the path. The offer
  // and answer are copy/paste blobs (or a link carrying the offer in
  // its hash); the hello exchange underneath is the same signed
  // handshake as the signaling path. Sessions live in refs — they
  // hold a live RTCPeerConnection and are not render state.
  const [manualSupported] = useState(() => isManualSdpSupported())
  const [manualMode, setManualMode] = useState<'idle' | 'offer' | 'answer'>('idle')
  const [manualOfferText, setManualOfferText] = useState('')
  const [manualOfferUrl, setManualOfferUrl] = useState('')
  const [manualAnswerInput, setManualAnswerInput] = useState('')
  const [manualOfferInput, setManualOfferInput] = useState('')
  const [manualAnswerText, setManualAnswerText] = useState('')
  const [manualBusy, setManualBusy] = useState(false)
  const manualOfferRef = useRef<ManualSdpSession | null>(null)
  const manualAnswerRef = useRef<ManualSdpSession | null>(null)

  const clearManual = useCallback(() => {
    manualOfferRef.current?.close()
    manualAnswerRef.current?.close()
    manualOfferRef.current = null
    manualAnswerRef.current = null
    setManualMode('idle')
    setManualOfferText('')
    setManualOfferUrl('')
    setManualAnswerInput('')
    setManualOfferInput('')
    setManualAnswerText('')
  }, [])

  const reload = useCallback(async () => {
    // Import on open: channel docs may already hold shares the live
    // update subscription has not imported yet (its App-level effect can
    // be mid-teardown when an update lands). Importing here makes the
    // shelf correct by construction whenever the user looks at it; the
    // import is idempotent (per-share updatedAt check).
    await importReceivedShares(identity).catch(() => 0)
    setFriends(listFriends())
    setReceived(await listReceivedShares())
  }, [identity])

  useEffect(() => {
    void reload()
  }, [reload])

  // A manual-offer link opens the app with the offer in the URL hash
  // (`#lt-manual-offer=<blob>`). Pick it up into the manual-answer
  // box when the panel opens, then clear the hash so the blob — which
  // carries the pair secret — does not linger in the URL bar.
  useEffect(() => {
    if (typeof window === 'undefined') return
    const hash = window.location.hash
    if (!hash.includes(`#${MANUAL_OFFER_HASH_PARAM}=`)) return
    setManualOfferInput(extractManualBlob(hash))
    setManualMode('answer')
    try {
      window.history.replaceState(
        null,
        '',
        window.location.pathname + window.location.search,
      )
    } catch {
      // The hash stays, but the blob is still usable from the box.
    }
  }, [])

  const myName = name.trim() || 'A Longtable cook'

  // Show my invite and start listening for whoever scans it.
  const showInvite = useCallback(async () => {
    // Sec L9: never mint a second invite while a pairing is already
    // listening. The guard runs BEFORE createFriendInvite, synchronously
    // — the old code minted first and checked pairingRef after, so a
    // double-tap minted a fresh invite (new room) while runPairing kept
    // listening on the first one: the displayed code had nobody on the
    // other end. While pairing runs, the button below is hidden (the
    // invite is shown instead), so this is the double-tap race only.
    if (pairingRef.current) return
    pairingRef.current = true
    setError(null)
    try {
      const inv = await createFriendInvite(identity, myName)
      setInvite(inv)
      const rec = await runPairing(identity, myName, inv, null, undefined, undefined, {
        singleUse: true,
      })
      setStatus(`You are now friends with ${rec.name || shortDid(rec.did)}.`)
      await joinFriendChannel(rec)
      await importReceivedShares(identity)
      await reload()
      onChanged()
    } catch (e) {
      // Timeout is normal if nobody scans; only surface real errors while
      // the panel is still open.
      setError(friendlyError(e))
    } finally {
      // Rel L9: the invite is cleared on EVERY exit — success, timeout,
      // or error. It used to stay displayed after the 90 s timeout with
      // "Waiting for them…" and nobody listening.
      setInvite(null)
      pairingRef.current = false
    }
  }, [identity, myName, reload, onChanged])

  const join = async (text?: string) => {
    setError(null)
    setStatus(null)
    setBusy(true)
    try {
      // Scanned or pasted, the text takes the exact same parse path.
      const inv = parseFriendInvite(text ?? joinCode)
      setDisplayName(myName)
      const rec = await runPairing(identity, myName, inv, inv.did, undefined, undefined, {
        singleUse: true,
        expectedPeerName: inv.name,
      })
      setStatus(`You are now friends with ${rec.name || shortDid(rec.did)}.`)
      await joinFriendChannel(rec)
      const n = await importReceivedShares(identity)
      if (n > 0) setStatus((s) => `${s ?? ''} ${n} shared recipe(s) received.`)
      setJoinCode('')
      await reload()
      onChanged()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  // Manual-SDP offerer: mint an invite + offer blob. Pairing itself
  // starts only once the guest's answer is pasted back (the 90 s
  // pairing clock covers the hello exchange, not the human copy/paste).
  const createManual = async () => {
    setError(null)
    setStatus(null)
    setManualBusy(true)
    try {
      const inv = await createFriendInvite(identity, myName)
      const session = await createManualOffer(inv, getIceServers())
      manualOfferRef.current = session
      setManualOfferText(session.offerText ?? '')
      setManualOfferUrl(
        session.offerText ? manualOfferLink(session.offerText) : '',
      )
      setManualMode('offer')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setManualBusy(false)
    }
  }

  // Manual-SDP offerer, step 2: apply the pasted answer, then pair.
  const completeManual = async () => {
    const session = manualOfferRef.current
    if (!session) return
    setError(null)
    setStatus(null)
    setManualBusy(true)
    try {
      await completeManualOffer(session, manualAnswerInput)
      const rec = await session.pair(identity, myName, undefined, undefined, {
        singleUse: true,
      })
      setStatus(
        `You are now friends with ${rec.name || shortDid(rec.did)} (paired without a hub).`,
      )
      await joinFriendChannel(rec)
      await importReceivedShares(identity)
      clearManual()
      await reload()
      onChanged()
    } catch (e) {
      setError(friendlyError(e))
      clearManual()
    } finally {
      setManualBusy(false)
    }
  }

  // Manual-SDP guest: take a pasted offer (blob or link), mint the
  // answer blob to copy back, and pair in the background — the
  // channel opens when the offerer applies the answer.
  const answerManual = async () => {
    setError(null)
    setStatus(null)
    setManualBusy(true)
    try {
      const session = await acceptManualOffer(manualOfferInput, getIceServers())
      manualAnswerRef.current = session
      setManualAnswerText(session.answerText ?? '')
      setManualMode('answer')
      setManualBusy(false)
      void session
        .pair(identity, myName, undefined, undefined, { singleUse: true })
        .then(async (rec) => {
          setStatus(
            `You are now friends with ${rec.name || shortDid(rec.did)} (paired without a hub).`,
          )
          await joinFriendChannel(rec)
          const n = await importReceivedShares(identity)
          if (n > 0) setStatus((s) => `${s ?? ''} ${n} shared recipe(s) received.`)
          clearManual()
          await reload()
          onChanged()
        })
        .catch((e: unknown) => {
          setError(friendlyError(e))
          clearManual()
        })
    } catch (e) {
      setError(friendlyError(e))
      setManualBusy(false)
    }
  }

  const unfriend = async (friend: FriendRecord) => {
    if (!window.confirm(`Remove ${friend.name || shortDid(friend.did)} as a friend? They will stop receiving updates to recipes you shared — those recipes get re-keyed. But recipes they have already received stay readable on their device: unfriending can't take back a copy that's already been delivered.`)) return
    setBusy(true)
    setError(null)
    try {
      await unfriendAndRekey(friend.did, identity)
      setStatus(`${friend.name || 'Friend'} removed. Your shared recipes were re-keyed, so they'll get no new versions — copies they already had stay on their device.`)
      await reload()
      onChanged()
    } catch (e) {
      setError(friendlyError(e))
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
          {scan.ok && (
            <button
              data-testid="friend-join-scan"
              disabled={busy}
              onClick={() => setScannerOpen(true)}
            >
              Scan a code
            </button>
          )}
          <button
            className="primary"
            data-testid="friend-join-confirm"
            disabled={busy || !joinCode.trim()}
            onClick={() => void join()}
          >
            {busy ? 'Pairing…' : 'Pair with this friend'}
          </button>
        </div>
        {!scan.ok && (
          <p className="muted" data-testid="friend-join-scan-unavailable">
            {scan.reason} Pasting the code still works.
          </p>
        )}

        <h3>Pair without a hub</h3>
        <p className="muted">
          No hub reachable? Pair by hand instead: one device creates an
          offer, the other answers it, and the two connect directly —
          the same signed pairing as the invite code, with no server in
          the path. Treat the offer and answer like the invite code:
          they carry the pairing secret, so send them only to your friend.
        </p>
        {!manualSupported ? (
          <p className="muted" data-testid="manual-unsupported">
            Manual pairing needs WebRTC, which this browser does not provide.
          </p>
        ) : (
          <>
            {manualMode !== 'answer' && (
              <>
                <button
                  data-testid="manual-offer-create"
                  disabled={manualBusy || manualMode === 'offer'}
                  onClick={() => void createManual()}
                >
                  {manualMode === 'offer' ? 'Offer created — send it to your friend' : 'Create a manual offer'}
                </button>
                {manualMode === 'offer' && (
                  <>
                    <label className="field-label" htmlFor="manual-offer-text">Your offer — send this to your friend</label>
                    <textarea
                      id="manual-offer-text"
                      rows={3}
                      readOnly
                      value={manualOfferText}
                      data-testid="manual-offer-text"
                      aria-label="Manual offer"
                      onFocus={(e) => e.target.select()}
                    />
                    <label className="field-label" htmlFor="manual-offer-link">…or as a link (the offer rides in the link, not on a server)</label>
                    <textarea
                      id="manual-offer-link"
                      rows={3}
                      readOnly
                      value={manualOfferUrl}
                      data-testid="manual-offer-link"
                      aria-label="Manual offer link"
                      onFocus={(e) => e.target.select()}
                    />
                    <label className="field-label" htmlFor="manual-answer-input">Paste their answer back here</label>
                    <textarea
                      id="manual-answer-input"
                      rows={3}
                      value={manualAnswerInput}
                      onChange={(e) => setManualAnswerInput(e.target.value)}
                      placeholder="Paste the answer blob"
                      data-testid="manual-answer-input"
                      aria-label="Manual answer to complete pairing"
                    />
                    <div className="modal-actions">
                      <button
                        className="primary"
                        data-testid="manual-answer-complete"
                        disabled={manualBusy || !manualAnswerInput.trim()}
                        onClick={() => void completeManual()}
                      >
                        {manualBusy ? 'Pairing…' : 'Pair with this answer'}
                      </button>
                      <button
                        className="ghost"
                        data-testid="manual-offer-cancel"
                        disabled={manualBusy}
                        onClick={clearManual}
                      >
                        Cancel
                      </button>
                    </div>
                  </>
                )}
              </>
            )}
            {manualMode !== 'offer' && (
              <>
                <label className="field-label" htmlFor="manual-offer-input">…or paste a friend's manual offer (blob or link)</label>
                <textarea
                  id="manual-offer-input"
                  rows={3}
                  value={manualOfferInput}
                  onChange={(e) => setManualOfferInput(e.target.value)}
                  placeholder="Paste the offer blob or link"
                  data-testid="manual-offer-input"
                  aria-label="Manual offer to answer"
                />
                <div className="modal-actions">
                  <button
                    className="primary"
                    data-testid="manual-answer-create"
                    disabled={manualBusy || !manualOfferInput.trim()}
                    onClick={() => void answerManual()}
                  >
                    {manualBusy ? 'Pairing…' : 'Create answer'}
                  </button>
                  {manualMode === 'answer' && (
                    <button
                      className="ghost"
                      data-testid="manual-answer-cancel"
                      disabled={manualBusy}
                      onClick={clearManual}
                    >
                      Cancel
                    </button>
                  )}
                </div>
                {manualMode === 'answer' && manualAnswerText && (
                  <>
                    <p className="muted">Waiting for the other device… send them your answer:</p>
                    <textarea
                      rows={3}
                      readOnly
                      value={manualAnswerText}
                      data-testid="manual-answer-text"
                      aria-label="Manual answer"
                      onFocus={(e) => e.target.select()}
                    />
                  </>
                )}
              </>
            )}
          </>
        )}

        <h3>Your friends</h3>
        <p className="muted" data-testid="unfriend-caveat">
          About unfriending: it stops future updates — recipes you shared
          are re-keyed, so an ex-friend can't read new versions. Copies a
          friend has already received stay readable on their device; once a
          recipe has been delivered, it can't be taken back.
        </p>
        {friends.length === 0 ? (
          <p className="empty" data-testid="friend-empty">
            No friends yet — pair with the invite code above; it takes about
            a minute once your friend pastes it.
          </p>
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
      {scannerOpen && (
        <QrScannerModal
          title="Scan a friend's invite code"
          onClose={() => setScannerOpen(false)}
          onScanned={(text) => {
            setScannerOpen(false)
            setJoinCode(text)
            void join(text)
          }}
        />
      )}
    </div>
  )
}
