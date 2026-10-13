import { useState } from 'react'
import type { RecipeInput } from '../types'
import {
  AtprotoClient,
  loadAppViewUrl,
  loadSession,
  saveAppViewUrl,
} from '../public/atproto'
import {
  blobBytesToDataUrl,
  fetchPublicRecipe,
  publicRecordToInput,
  searchAppView,
  type PublicRecipe,
  type PublicSearchResult,
} from '../public/discover'
import { getActiveHub } from '../hubs/hubs'
import { friendlyError } from '../friendlyError'

interface DiscoverProps {
  onClose: () => void
  /** App's create handler: saves the input as a new local recipe. */
  onSaveCopy: (input: RecipeInput) => Promise<void> | void
}

function shortDid(did: string): string {
  return did.length > 28 ? `${did.slice(0, 20)}…${did.slice(-6)}` : did
}

/**
 * Read-only view of one public recipe, with its author's account DID and
 * a "Save a copy" action that imports it as an ordinary local recipe.
 */
export function PublicRecipeView({
  record,
  onBack,
  onSaveCopy,
}: {
  record: PublicRecipe
  onBack: () => void
  onSaveCopy: () => Promise<void> | void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await onSaveCopy()
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div data-testid="public-recipe-view">
      <div className="modal-actions" style={{ justifyContent: 'flex-start' }}>
        <button className="ghost" data-testid="public-back" onClick={onBack}>
          ‹ Discover
        </button>
      </div>
      <h3 className="detail-title">{record.name || 'Untitled'}</h3>
      <p className="muted">
        by <span data-testid="public-author">{record.did}</span>
      </p>
      {record.deviceDid && (
        <p className="muted">Device: {shortDid(record.deviceDid)}</p>
      )}
      {record.description && <p>{record.description}</p>}
      <div className="times">
        <span>
          Prep <strong>{record.prepTimeMinutes === undefined ? '—' : `${record.prepTimeMinutes} min`}</strong>
        </span>
        <span>
          Cook <strong>{record.cookTimeMinutes === undefined ? '—' : `${record.cookTimeMinutes} min`}</strong>
        </span>
      </div>
      <section>
        <h2>Ingredients</h2>
        {record.ingredients.length === 0 ? (
          <p className="empty">No ingredients listed.</p>
        ) : (
          <ul className="ingredients">
            {record.ingredients.map((ing, i) => (
              <li key={i}>{ing}</li>
            ))}
          </ul>
        )}
      </section>
      <section>
        <h2>Steps</h2>
        {record.instructions.length === 0 ? (
          <p className="empty">No steps listed.</p>
        ) : (
          <ol className="steps">
            {record.instructions.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
      </section>
      {error && <p className="status error">{error}</p>}
      <div className="modal-actions">
        <button
          className="primary"
          data-testid="public-save-copy"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save a copy'}
        </button>
      </div>
    </div>
  )
}

/**
 * In-app discovery: search the hub AppView by name and/or ingredients,
 * open a result read-only, and save a local copy (photos are pulled from
 * the author's PDS as blobs and stored as data URLs, like any import).
 */
export function DiscoverPanel({ onClose, onSaveCopy }: DiscoverProps) {
  const [appViewUrl, setAppViewUrl] = useState(() => loadAppViewUrl())
  const [q, setQ] = useState('')
  const [ingredients, setIngredients] = useState('')
  const [results, setResults] = useState<PublicSearchResult[]>([])
  const [selected, setSelected] = useState<PublicRecipe | null>(null)
  const [searched, setSearched] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const search = async () => {
    setBusy(true)
    setError(null)
    setSelected(null)
    try {
      const url = appViewUrl.trim() || loadAppViewUrl()
      saveAppViewUrl(url)
      const found = await searchAppView(url, {
        q: q.trim() || undefined,
        ingredients:
          ingredients
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) || undefined,
      })
      setResults(found)
      setSearched(true)
    } catch (e) {
      setError(friendlyError(e, 'the discovery service'))
    } finally {
      setBusy(false)
    }
  }

  const openResult = async (r: PublicSearchResult) => {
    setBusy(true)
    setError(null)
    try {
      const url = appViewUrl.trim() || loadAppViewUrl()
      setSelected(await fetchPublicRecipe(url, r.did, r.rkey))
    } catch (e) {
      setError(friendlyError(e, 'the discovery service'))
    } finally {
      setBusy(false)
    }
  }

  const saveCopyOfSelected = async () => {
    if (!selected) return
    const rec = selected
    // Photos live as blobs on the author's PDS. On the local testnet that
    // is the same PDS the settings point at; fall back to the canonical
    // local testnet address when this device has never signed in.
    const pdsUrl = loadSession()?.pdsUrl || getActiveHub().pdsUrl
    const client = new AtprotoClient(pdsUrl)
    const input = await publicRecordToInput(rec, async (cid, blob) => {
      const buf = await client.getBlob(rec.did, cid)
      return blobBytesToDataUrl(new Uint8Array(buf), blob)
    })
    await onSaveCopy(input)
    onClose()
  }

  return (
    <div className="modal-backdrop" data-testid="discover-panel">
      <div className="modal modal-wide" role="dialog" aria-label="Discover public recipes">
        {selected ? (
          <PublicRecipeView
            record={selected}
            onBack={() => setSelected(null)}
            onSaveCopy={saveCopyOfSelected}
          />
        ) : (
          <>
            <h2>Discover public recipes</h2>
            <p className="muted">
              Public recipes are published by their authors on ATProto.
              Saving a copy imports it into your local recipe box.
            </p>
            <label className="field-label" htmlFor="appview-url">Discovery service (AppView) URL</label>
            <input
              id="appview-url"
              type="url"
              data-testid="field-appview-url"
              value={appViewUrl}
              onChange={(e) => setAppViewUrl(e.target.value)}
            />
            <p className="muted">
              Usually set by your hub — change it only if you use a different
              discovery service.
            </p>
            <label className="field-label" htmlFor="discover-q">Search by name</label>
            <input
              id="discover-q"
              type="text"
              data-testid="field-discover-q"
              value={q}
              onChange={(e) => setQ(e.target.value)}
            />
            <label className="field-label" htmlFor="discover-ingredients">
              Ingredients (comma-separated)
            </label>
            <input
              id="discover-ingredients"
              type="text"
              data-testid="field-discover-ingredients"
              value={ingredients}
              onChange={(e) => setIngredients(e.target.value)}
            />
            {error && <p className="status error">{error}</p>}
            <div className="modal-actions">
              <button
                className="primary"
                data-testid="discover-search"
                disabled={busy}
                onClick={() => void search()}
              >
                {busy ? 'Searching…' : 'Search'}
              </button>
              <button className="ghost" data-testid="close-discover" onClick={onClose}>
                Close
              </button>
            </div>
            {!searched && results.length === 0 && (
              <p className="empty" data-testid="discover-hint">
                Search for a dish by name, or list ingredients you have —
                for example “eggs, spinach” — to find public recipes that
                use them.
              </p>
            )}
            {searched && results.length === 0 && (
              <p className="empty" data-testid="discover-no-results">
                No public recipes matched — try a shorter name or fewer ingredients.
              </p>
            )}
            <ul className="recipe-cards">
              {results.map((r) => (
                <li key={`${r.did}/${r.rkey}`}>
                  <button
                    className="recipe-card"
                    data-testid="discover-result"
                    onClick={() => void openResult(r)}
                  >
                    <span className="recipe-card-title">{r.title}</span>
                    <span className="recipe-card-meta">{shortDid(r.did)}</span>
                    {r.ingredients.length > 0 && (
                      <span className="recipe-card-meta">
                        {r.ingredients.slice(0, 3).join(', ')}
                        {r.ingredients.length > 3 ? '…' : ''}
                      </span>
                    )}
                  </button>
                </li>
              ))}
            </ul>
          </>
        )}
      </div>
    </div>
  )
}
