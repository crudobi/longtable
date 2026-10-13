import { useCallback, useEffect, useState } from 'react'
import type { Identity } from '../identity/identity'
import {
  AtprotoClient,
  PUBKEY_COLLECTION,
  clearSession,
  loadSession,
  saveSession,
  type AtprotoSession,
} from '../public/atproto'

interface Props {
  identity: Identity | null
  onClose: () => void
  onSessionChanged?: () => void
}

function shortDid(did: string): string {
  return did.length > 28 ? `${did.slice(0, 20)}…${did.slice(-6)}` : did
}

/**
 * ATProto publishing settings: sign in to the (testnet) PDS with a handle
 * + app password, see the account DID, this device's DID, and whether the
 * kitchen.longtable.pubkey binding record is in place for this device.
 */
export function PublishSettingsModal({ identity, onClose, onSessionChanged }: Props) {
  const [session, setSession] = useState<AtprotoSession | null>(() => loadSession())
  const [pdsUrl, setPdsUrl] = useState(() => loadSession()?.pdsUrl ?? '')
  const [handle, setHandle] = useState(() => loadSession()?.handle ?? '')
  const [password, setPassword] = useState('')
  const [binding, setBinding] = useState<string>('unknown')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const checkBinding = useCallback(
    async (sess: AtprotoSession | null) => {
      if (!sess || !identity) {
        setBinding('unknown')
        return
      }
      try {
        const client = new AtprotoClient(sess.pdsUrl)
        const rec = await client.getRecord(sess.did, PUBKEY_COLLECTION, 'self')
        if (!rec) setBinding('not bound yet — created automatically on first publish')
        else if (rec.value.deviceDid === identity.did) setBinding('bound to this device')
        else setBinding('bound to a different device — re-bound on next publish')
      } catch {
        setBinding('could not be checked (PDS unreachable)')
      }
    },
    [identity],
  )

  useEffect(() => {
    void checkBinding(session)
    // Run once on open (and when identity lands); sign-in/out re-check explicitly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [identity])

  const signIn = async () => {
    setBusy(true)
    setError(null)
    try {
      const url = pdsUrl.trim()
      if (!url) throw new Error('Enter the PDS URL first.')
      const client = new AtprotoClient(url)
      const sess = await client.createSession(handle.trim(), password)
      saveSession(sess)
      setSession(sess)
      setPassword('')
      onSessionChanged?.()
      await checkBinding(sess)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const signOut = () => {
    clearSession()
    setSession(null)
    setBinding('unknown')
    onSessionChanged?.()
  }

  return (
    <div className="modal-backdrop" data-testid="publish-settings-modal">
      <div className="modal" role="dialog" aria-label="Publishing settings">
        <h2>Public publishing (ATProto)</h2>
        <p className="muted">
          Publishing puts a signed copy of a recipe on your PDS so anyone can
          find it in Discover. Private and friends-only recipes never leave
          this device (friends-only stays encrypted).
        </p>

        <p className="status" data-testid="atproto-session-status">
          {session ? (
            <>
              Signed in as <strong>{session.handle || session.did}</strong>
              <br />
              Account DID: <span>{shortDid(session.did)}</span>
              <br />
              Device DID: <span>{identity ? shortDid(identity.did) : '…'}</span>
              <br />
              Pubkey binding: <span>{binding}</span>
            </>
          ) : (
            <>
              Not signed in.
              <br />
              Device DID: <span>{identity ? shortDid(identity.did) : '…'}</span>
            </>
          )}
        </p>

        {!session && (
          <>
            <label className="field-label" htmlFor="pds-url">PDS URL</label>
            <input
              id="pds-url"
              type="url"
              placeholder="http://localhost:2583"
              data-testid="field-pds-url"
              value={pdsUrl}
              onChange={(e) => setPdsUrl(e.target.value)}
            />
            <label className="field-label" htmlFor="atproto-handle">Handle</label>
            <input
              id="atproto-handle"
              type="text"
              autoComplete="username"
              data-testid="field-handle"
              value={handle}
              onChange={(e) => setHandle(e.target.value)}
            />
            <label className="field-label" htmlFor="atproto-password">App password</label>
            <input
              id="atproto-password"
              type="password"
              autoComplete="current-password"
              data-testid="field-app-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </>
        )}

        {error && (
          <p className="status error" data-testid="atproto-error">{error}</p>
        )}

        <div className="modal-actions">
          {session ? (
            <button data-testid="atproto-signout" onClick={signOut}>
              Sign out
            </button>
          ) : (
            <button
              className="primary"
              data-testid="atproto-signin"
              disabled={busy || !handle.trim() || !password}
              onClick={() => void signIn()}
            >
              {busy ? 'Signing in…' : 'Sign in'}
            </button>
          )}
          <button className="ghost" data-testid="close-publish-settings" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
