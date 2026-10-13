import { useState } from 'react'
import {
  addHub,
  getActiveHub,
  listHubs,
  removeHub,
  setActiveHub,
  type HubConfig,
} from '../hubs/hubs'

interface Props {
  onClose: () => void
  /** Fired after the hub list or the active hub changes, so the app can
   * rebuild its network providers against the new endpoints. */
  onChanged?: () => void
}

/**
 * Hub settings (Phase 4): list / add / remove / select hubs.
 *
 * A hub is only a bundle of endpoints (signaling, TURN, AppView, default
 * PDS). Nothing of the user's lives on a hub — recipes, friends, shares,
 * and identity are all local — so switching hubs loses nothing, and the
 * network survives any hub's death.
 */
export function HubSettingsModal({ onClose, onChanged }: Props) {
  const [hubs, setHubs] = useState<HubConfig[]>(() => listHubs())
  const [activeId, setActiveId] = useState<string>(() => getActiveHub().id)
  const [error, setError] = useState('')
  const [name, setName] = useState('')
  const [signaling, setSignaling] = useState('')
  const [turn, setTurn] = useState('')
  const [turnUser, setTurnUser] = useState('')
  const [turnPass, setTurnPass] = useState('')
  const [appview, setAppview] = useState('')
  const [pds, setPds] = useState('')

  const refresh = () => {
    setHubs(listHubs())
    setActiveId(getActiveHub().id)
  }

  const activate = (id: string) => {
    try {
      setActiveHub(id)
      setError('')
      refresh()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const remove = (id: string) => {
    try {
      removeHub(id)
      setError('')
      refresh()
      onChanged?.()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  const add = () => {
    try {
      if (!name.trim()) throw new Error('Give the hub a name.')
      if (!signaling.trim()) throw new Error('Enter the hub signaling URL (wss://…).')
      if (!appview.trim()) throw new Error('Enter the hub AppView URL.')
      if (!pds.trim()) throw new Error('Enter the hub PDS URL.')
      const hub = addHub({
        name: name.trim(),
        signalingUrl: signaling.trim(),
        stunUrl: turn.trim() ? turn.trim().replace(/^turn:/, 'stun:') : undefined,
        turnUrl: turn.trim() || undefined,
        turnUsername: turnUser.trim() || undefined,
        turnCredential: turnPass || undefined,
        appviewUrl: appview.trim(),
        pdsUrl: pds.trim(),
      })
      setName('')
      setSignaling('')
      setTurn('')
      setTurnUser('')
      setTurnPass('')
      setAppview('')
      setPds('')
      setError('')
      refresh()
      onChanged?.()
      // Adding a hub the user just typed usually means "use this one".
      activate(hub.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <div className="modal-backdrop" data-testid="hubs-modal">
      <div className="modal modal-wide" role="dialog" aria-label="Hub settings">
        <h2>Hubs</h2>
        <p className="muted">
          A hub relays encrypted sync traffic, helps devices find each other,
          and indexes public recipes. It can never read your recipes. Your
          recipes, friends, and identity live on this device — switching hubs
          loses nothing, and if a hub dies the others carry on.
        </p>

        <ul className="hub-list">
          {hubs.map((h) => (
            <li key={h.id} data-testid={`hub-row-${h.id}`} className="hub-row">
              <div>
                <strong>{h.name}</strong>
                {h.id === activeId && <span data-testid="hub-active-badge"> · active</span>}
                <br />
                <span className="muted">{h.signalingUrl}</span>
              </div>
              <div className="modal-actions">
                {h.id !== activeId && (
                  <button data-testid={`hub-set-active-${h.id}`} onClick={() => activate(h.id)}>
                    Use this hub
                  </button>
                )}
                <button
                  className="ghost"
                  data-testid={`hub-remove-${h.id}`}
                  disabled={hubs.length <= 1}
                  onClick={() => remove(h.id)}
                >
                  Remove
                </button>
              </div>
            </li>
          ))}
        </ul>

        <h3>Add a hub</h3>
        <label className="field-label" htmlFor="hub-name">Name</label>
        <input id="hub-name" type="text" data-testid="field-hub-name" value={name}
          onChange={(e) => setName(e.target.value)} />
        <label className="field-label" htmlFor="hub-signaling">Signaling URL (wss)</label>
        <input id="hub-signaling" type="url" placeholder="wss://hub.example:4444" data-testid="field-hub-signaling" value={signaling}
          onChange={(e) => setSignaling(e.target.value)} />
        <label className="field-label" htmlFor="hub-turn">TURN URL (optional)</label>
        <input id="hub-turn" type="text" placeholder="turn:hub.example:3478" data-testid="field-hub-turn" value={turn}
          onChange={(e) => setTurn(e.target.value)} />
        <label className="field-label" htmlFor="hub-turn-user">TURN username</label>
        <input id="hub-turn-user" type="text" data-testid="field-hub-turn-user" value={turnUser}
          onChange={(e) => setTurnUser(e.target.value)} />
        <label className="field-label" htmlFor="hub-turn-pass">TURN password</label>
        <input id="hub-turn-pass" type="password" data-testid="field-hub-turn-pass" value={turnPass}
          onChange={(e) => setTurnPass(e.target.value)} />
        <label className="field-label" htmlFor="hub-appview">AppView URL</label>
        <input id="hub-appview" type="url" placeholder="https://hub.example:3211" data-testid="field-hub-appview" value={appview}
          onChange={(e) => setAppview(e.target.value)} />
        <label className="field-label" htmlFor="hub-pds">PDS URL</label>
        <input id="hub-pds" type="url" placeholder="https://hub.example:2584" data-testid="field-hub-pds" value={pds}
          onChange={(e) => setPds(e.target.value)} />

        {error && <p className="status error" data-testid="hubs-error">{error}</p>}

        <div className="modal-actions">
          <button className="primary" data-testid="add-hub" onClick={add}>
            Add hub
          </button>
          <button className="ghost" data-testid="close-hubs" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>
  )
}
