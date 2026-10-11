import { useState } from 'react'
import { UrlImportError, importRecipeFromUrl } from '../importers/urlImport'
import type { RecipeInput } from '../types'

interface Props {
  onImport: (partial: Partial<RecipeInput>) => void
  onClose: () => void
}

/**
 * URL import dialog. Clearly labeled: fetching a page is the user's choice
 * and is the only network request the app ever makes.
 */
export function UrlImportDialog({ onImport, onClose }: Props) {
  const [url, setUrl] = useState('')
  const [status, setStatus] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const run = async () => {
    setBusy(true)
    setStatus(null)
    try {
      const partial = await importRecipeFromUrl(url)
      onImport(partial)
      onClose()
    } catch (err) {
      if (err instanceof UrlImportError) {
        setStatus(err.message)
      } else {
        setStatus('Could not read that page — the site blocked cross-origin reading.')
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog"
        role="dialog"
        aria-label="Import recipe from URL"
        onClick={(e) => e.stopPropagation()}
      >
        <h2>Import from URL</h2>
        <p className="dialog-note">
          Paste a recipe page link. Longtable fetches that page once, reads its
          recipe metadata, and fills the form. This is the only time the app
          ever contacts the network.
        </p>
        <input
          type="url"
          inputMode="url"
          placeholder="https://example.com/recipe"
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          data-testid="field-url"
          autoFocus
        />
        {status && (
          <p className="status error" data-testid="import-status">
            {status}
          </p>
        )}
        <div className="dialog-actions">
          <button className="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="primary"
            data-testid="fetch-url"
            onClick={run}
            disabled={busy || url.trim() === ''}
          >
            {busy ? 'Fetching…' : 'Fetch recipe'}
          </button>
        </div>
      </div>
    </div>
  )
}
