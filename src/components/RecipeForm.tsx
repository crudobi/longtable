import { useState } from 'react'
import { filesToDataUrls } from '../importers/photoImport'
import { UrlImportDialog } from './UrlImportDialog'
import type { RecipeInput } from '../types'

interface Props {
  initial: RecipeInput
  heading: string
  onSave: (input: RecipeInput) => void
  onCancel: () => void
}

function parseMinutes(raw: string): number | undefined {
  const n = Number(raw)
  return raw.trim() !== '' && Number.isFinite(n) && n >= 0 ? n : undefined
}

export function RecipeForm({ initial, heading, onSave, onCancel }: Props) {
  const [title, setTitle] = useState(initial.title)
  const [ingredients, setIngredients] = useState<string[]>(initial.ingredients)
  const [steps, setSteps] = useState<string[]>(initial.steps)
  const [photos, setPhotos] = useState<string[]>(initial.photos)
  const [prep, setPrep] = useState(initial.prepMinutes?.toString() ?? '')
  const [cook, setCook] = useState(initial.cookMinutes?.toString() ?? '')
  const [ingredientDraft, setIngredientDraft] = useState('')
  const [stepDraft, setStepDraft] = useState('')
  const [photoBusy, setPhotoBusy] = useState(false)
  const [importOpen, setImportOpen] = useState(false)

  const addIngredient = () => {
    const v = ingredientDraft.trim()
    if (v) setIngredients((xs) => [...xs, v])
    setIngredientDraft('')
  }

  const addStep = () => {
    const v = stepDraft.trim()
    if (v) setSteps((xs) => [...xs, v])
    setStepDraft('')
  }

  const attachPhotos = async (files: FileList | null) => {
    if (!files || files.length === 0) return
    setPhotoBusy(true)
    try {
      const urls = await filesToDataUrls(files)
      setPhotos((xs) => [...xs, ...urls])
    } finally {
      setPhotoBusy(false)
    }
  }

  const applyImport = (partial: Partial<RecipeInput>) => {
    if (partial.title) setTitle(partial.title)
    if (partial.ingredients && partial.ingredients.length > 0)
      setIngredients(partial.ingredients)
    if (partial.steps && partial.steps.length > 0) setSteps(partial.steps)
    if (partial.photos && partial.photos.length > 0) setPhotos((xs) => [...xs, ...partial.photos!])
  }

  const save = () => {
    onSave({
      title: title.trim(),
      ingredients,
      steps,
      photos,
      prepMinutes: parseMinutes(prep),
      cookMinutes: parseMinutes(cook),
    })
  }

  return (
    <div className="view" data-testid="recipe-form">
      <header className="app-header">
        <button className="ghost" onClick={onCancel}>
          ‹ Cancel
        </button>
        <h1 className="header-title">{heading}</h1>
        <button className="primary" data-testid="save-recipe" onClick={save}>
          Save
        </button>
      </header>

      <button className="import-link" data-testid="import-url" onClick={() => setImportOpen(true)}>
        Import from a web page…
      </button>
      {importOpen && (
        <UrlImportDialog onImport={applyImport} onClose={() => setImportOpen(false)} />
      )}

      <label className="field">
        <span>Name</span>
        <input
          data-testid="field-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="e.g. Sunday ragù"
        />
      </label>

      <div className="field-row">
        <label className="field">
          <span>Prep (min)</span>
          <input
            data-testid="field-prep"
            inputMode="numeric"
            value={prep}
            onChange={(e) => setPrep(e.target.value)}
            placeholder="—"
          />
        </label>
        <label className="field">
          <span>Cook (min)</span>
          <input
            data-testid="field-cook"
            inputMode="numeric"
            value={cook}
            onChange={(e) => setCook(e.target.value)}
            placeholder="—"
          />
        </label>
      </div>

      <div className="field">
        <span>Ingredients</span>
        <ul className="edit-list">
          {ingredients.map((ing, i) => (
            <li key={i}>
              <span>{ing}</span>
              <button
                className="icon-btn"
                aria-label={`Remove ingredient ${i + 1}`}
                onClick={() => setIngredients((xs) => xs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
        <div className="add-row">
          <input
            data-testid="field-ingredient"
            value={ingredientDraft}
            onChange={(e) => setIngredientDraft(e.target.value)}
            placeholder="Add an ingredient"
            onKeyDown={(e) => {
              if (e.key === 'Enter') addIngredient()
            }}
          />
          <button data-testid="add-ingredient" onClick={addIngredient}>
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <span>Steps</span>
        <ol className="edit-list">
          {steps.map((step, i) => (
            <li key={i}>
              <span>{step}</span>
              <button
                className="icon-btn"
                aria-label={`Remove step ${i + 1}`}
                onClick={() => setSteps((xs) => xs.filter((_, j) => j !== i))}
              >
                ×
              </button>
            </li>
          ))}
        </ol>
        <div className="add-row">
          <input
            data-testid="field-step"
            value={stepDraft}
            onChange={(e) => setStepDraft(e.target.value)}
            placeholder="Add a step"
            onKeyDown={(e) => {
              if (e.key === 'Enter') addStep()
            }}
          />
          <button data-testid="add-step" onClick={addStep}>
            Add
          </button>
        </div>
      </div>

      <div className="field">
        <span>Photos</span>
        {photos.length > 0 && (
          <div className="photo-grid">
            {photos.map((src, i) => (
              <div key={i} className="photo-thumb">
                <img src={src} alt={`Attached photo ${i + 1}`} />
                <button
                  className="icon-btn photo-remove"
                  aria-label={`Remove photo ${i + 1}`}
                  onClick={() => setPhotos((xs) => xs.filter((_, j) => j !== i))}
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <label className="file-label">
          <input
            type="file"
            accept="image/*"
            multiple
            data-testid="field-photos"
            onChange={(e) => {
              void attachPhotos(e.target.files)
              e.target.value = ''
            }}
          />
          <span className="file-button">{photoBusy ? 'Reading…' : 'Attach photos'}</span>
        </label>
      </div>
    </div>
  )
}
