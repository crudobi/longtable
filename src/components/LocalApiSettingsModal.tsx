import { useEffect, useState } from 'react'
import { friendlyError } from '../friendlyError'
import { localApiAvailable } from '../localapi/plugin'
import {
  ensureLocalApiToken,
  generateLocalApiToken,
  loadLocalApiSettings,
  saveLocalApiSettings,
  type LocalApiSettings,
} from '../localapi/settings'
import { localApiServerStatus, syncLocalApiServer } from '../localapi/server'

interface Props {
  onClose: () => void
}

/**
 * Developer settings — the localhost API (E9).
 *
 * Plain-language front door for the API: what it is, that it's off by
 * default, the address + token while it's on, a token regenerate, and
 * a port picker. Outside the Android app (browser/PWA) there is no
 * native plugin, so the panel says that instead of offering a toggle
 * that would fail silently.
 */
export function LocalApiSettingsModal({ onClose }: Props) {
  const available = localApiAvailable()
  const [settings, setSettings] = useState<LocalApiSettings>(() =>
    loadLocalApiSettings(),
  )
  const [portDraft, setPortDraft] = useState(() => String(settings.port))
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  useEffect(() => {
    let live = true
    void localApiServerStatus().then((s) => {
      if (live) setRunning(s.running)
    })
    return () => {
      live = false
    }
  }, [])

  const apply = async (next: LocalApiSettings, noteText = '') => {
    setBusy(true)
    setError('')
    try {
      saveLocalApiSettings(next)
      setSettings(next)
      setPortDraft(String(next.port))
      const s = await syncLocalApiServer()
      setRunning(s.running)
      setNote(noteText)
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  const toggle = (on: boolean) => {
    // The token is minted the first time the API is switched on.
    const base = on ? ensureLocalApiToken(settings) : settings
    void apply(
      { ...base, enabled: on },
      on ? '' : 'The API is off. Scripts can no longer connect.',
    )
  }

  const regenerate = () => {
    void apply(
      { ...settings, token: generateLocalApiToken() },
      'New token saved. Scripts using the old token stop working right away.',
    )
  }

  const applyPort = () => {
    const n = Number(portDraft)
    if (!Number.isInteger(n) || n < 1024 || n > 65535) {
      setError('Port must be a whole number between 1024 and 65535.')
      return
    }
    void apply(
      { ...settings, port: n },
      settings.enabled
        ? 'Port changed — the API now answers on the new port.'
        : '',
    )
  }

  return (
    <div className="modal-backdrop" data-testid="developer-modal">
      <div className="modal modal-wide" role="dialog" aria-label="Developer settings">
        <h2>Developer</h2>
        <h3>Localhost API</h3>
        {!available ? (
          <p className="muted" data-testid="localapi-unavailable">
            The localhost API is part of the Longtable Android app — it
            isn&rsquo;t available in a web browser. Open Longtable on your
            phone or tablet to turn it on.
          </p>
        ) : (
          <>
            <p className="muted">
              The localhost API lets other apps and scripts on this device
              work with your cookbook — for example, a script that files
              this week&rsquo;s recipes. It only answers on this device
              itself (127.0.0.1), only while Longtable is open, and it is
              off unless you turn it on here.
            </p>
            <label className="localapi-toggle-row">
              <input
                type="checkbox"
                data-testid="localapi-toggle"
                checked={settings.enabled}
                disabled={busy}
                onChange={(e) => toggle(e.target.checked)}
              />
              <span>Turn on the localhost API</span>
            </label>
            {settings.enabled && (
              <>
                <p className="badge" data-testid="localapi-status">
                  {running ? 'Running' : 'Starting…'} at{' '}
                  <code data-testid="localapi-address">
                    http://127.0.0.1:{settings.port}
                  </code>
                </p>
                <label className="field-label" htmlFor="localapi-token-value">
                  API token — treat it like a password
                </label>
                <p
                  className="localapi-token"
                  id="localapi-token-value"
                  data-testid="localapi-token"
                >
                  {settings.token}
                </p>
                <p className="muted">
                  Any app on this device that has this token can read and
                  change your recipes. Turning the API off — or making a
                  new token — cuts off access right away.
                </p>
                <div className="modal-actions">
                  <button
                    data-testid="localapi-regenerate"
                    disabled={busy}
                    onClick={regenerate}
                  >
                    Make a new token
                  </button>
                </div>
                <label className="field-label" htmlFor="localapi-port">
                  Port
                </label>
                <input
                  id="localapi-port"
                  data-testid="localapi-port"
                  type="number"
                  min={1024}
                  max={65535}
                  value={portDraft}
                  onChange={(e) => setPortDraft(e.target.value)}
                />
                <div className="modal-actions">
                  <button
                    data-testid="localapi-apply-port"
                    disabled={busy}
                    onClick={applyPort}
                  >
                    Use this port
                  </button>
                </div>
              </>
            )}
            {note && (
              <p className="status" data-testid="localapi-note">
                {note}
              </p>
            )}
          </>
        )}
        {error && <p className="status error">{error}</p>}
        <div className="modal-actions">
          <button data-testid="close-developer" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
