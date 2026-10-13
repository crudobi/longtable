import { useEffect, useMemo, useState } from 'react'
import type { RecipeInput } from '../types'
import type { ImporterInput, RecipeImporter } from '../importers/contract'
import {
  ensurePluginsLoaded,
  listImporters,
  listPluginIssues,
  runImporter,
} from '../importers/registry'
import { friendlyError } from '../friendlyError'

interface Props {
  onClose: () => void
  /** Create the validated recipes in the cookbook. Called only after the
   *  whole import run validated — a failed run imports nothing. */
  onImported: (recipes: RecipeInput[]) => Promise<void> | void
}

/**
 * Import recipes through the importer registry (Importer API v1).
 *
 * Every importer the app ships — plus any drop-in plugins found in
 * src/importers/plugins — is listed here with the input it accepts:
 * a file, pasted text, or a URL. Plugins that failed to load are named,
 * with the reason, instead of failing silently.
 */
export function ImportPanel({ onClose, onImported }: Props) {
  const [importers, setImporters] = useState<RecipeImporter[]>(() => listImporters())
  const [issues, setIssues] = useState(() => listPluginIssues())
  const [selectedId, setSelectedId] = useState<string>(() => listImporters()[0]?.id ?? '')
  const [url, setUrl] = useState('')
  const [text, setText] = useState('')
  const [fileText, setFileText] = useState<string | null>(null)
  const [fileName, setFileName] = useState('')
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // Drop-in plugins load lazily; refresh the list when they land.
  useEffect(() => {
    let live = true
    void ensurePluginsLoaded().then(() => {
      if (!live) return
      setImporters(listImporters())
      setIssues(listPluginIssues())
    })
    return () => {
      live = false
    }
  }, [])

  const selected = useMemo(
    () => importers.find((i) => i.id === selectedId) ?? importers[0],
    [importers, selectedId],
  )

  const pickFile = async (file: File | null) => {
    setResult(null)
    setError(null)
    if (!file) {
      setFileText(null)
      setFileName('')
      return
    }
    try {
      setFileText(await file.text())
      setFileName(file.name)
    } catch {
      setError("That file couldn't be read on this device.")
    }
  }

  const buildInput = (): ImporterInput | null => {
    if (!selected) return null
    if (selected.accepts.includes('url') && url.trim()) {
      return { kind: 'url', url: url.trim() }
    }
    if (selected.accepts.includes('file') && fileText !== null) {
      return { kind: 'file', text: fileText, fileName }
    }
    if (selected.accepts.includes('text') && text.trim()) {
      return { kind: 'text', text }
    }
    // Fall back to whichever declared kind the user filled in.
    if (selected.accepts.includes('file')) return { kind: 'file', text: fileText ?? '' }
    if (selected.accepts.includes('text')) return { kind: 'text', text }
    if (selected.accepts.includes('url')) return { kind: 'url', url: url.trim() }
    return null
  }

  const run = async () => {
    if (!selected) return
    const input = buildInput()
    if (!input) return
    setBusy(true)
    setResult(null)
    setError(null)
    try {
      const { recipes } = await runImporter(selected.id, input)
      await onImported(recipes)
      setResult(
        recipes.length === 1
          ? `Imported “${recipes[0].title}”.`
          : `Imported ${recipes.length} recipes: ${recipes.map((r) => `“${r.title}”`).join(', ')}.`,
      )
      setText('')
      setFileText(null)
      setFileName('')
      setUrl('')
    } catch (e) {
      setError(friendlyError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="modal-backdrop" data-testid="import-panel">
      <div className="modal modal-wide" role="dialog" aria-label="Import recipes">
        <h2>Import recipes</h2>
        <p className="muted">
          Bring recipes in from another app or a file. Pick where they're
          coming from, give Longtable the source, and the recipes land in
          your cookbook — stored on this device like everything else.
        </p>

        <label className="field-label" htmlFor="importer-select">Import from</label>
        <select
          id="importer-select"
          data-testid="importer-select"
          value={selected?.id ?? ''}
          onChange={(e) => {
            setSelectedId(e.target.value)
            setResult(null)
            setError(null)
          }}
        >
          {importers.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name}
            </option>
          ))}
        </select>
        {selected?.description && <p className="muted">{selected.description}</p>}

        {issues.length > 0 && (
          <div className="status error" data-testid="plugin-issues">
            {issues.map((issue) => (
              <p key={issue.file}>
                An importer plugin ({issue.file.split('/').pop()}) couldn't load: {issue.message}.
                Everything else still works.
              </p>
            ))}
          </div>
        )}

        {selected?.accepts.includes('url') && (
          <>
            <label className="field-label" htmlFor="import-url">Recipe page URL</label>
            <input
              id="import-url"
              type="url"
              inputMode="url"
              placeholder="https://example.com/recipe"
              data-testid="import-url"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
          </>
        )}

        {selected?.accepts.includes('file') && (
          <>
            <label className="field-label" htmlFor="import-file">File</label>
            <input
              id="import-file"
              type="file"
              accept={(selected.fileExtensions ?? []).join(',') || undefined}
              data-testid="import-file"
              onChange={(e) => void pickFile(e.target.files?.[0] ?? null)}
            />
            {fileName && <p className="muted">Chosen: {fileName}</p>}
          </>
        )}

        {selected?.accepts.includes('text') && (
          <>
            <label className="field-label" htmlFor="import-text">
              …or paste the {selected.accepts.includes('file') ? 'file contents' : 'text'} here
            </label>
            <textarea
              id="import-text"
              rows={6}
              data-testid="import-text"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="Paste here"
            />
          </>
        )}

        {result && (
          <p className="status" data-testid="import-result">{result}</p>
        )}
        {error && (
          <p className="status error" data-testid="import-error">{error}</p>
        )}

        <div className="modal-actions">
          <button
            className="primary"
            data-testid="run-import"
            disabled={busy || !selected}
            onClick={() => void run()}
          >
            {busy ? 'Importing…' : 'Import'}
          </button>
          <button className="ghost" data-testid="close-import" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </div>
  )
}
