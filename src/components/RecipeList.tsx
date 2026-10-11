import type { RecipeSummary } from '../types'

interface Props {
  recipes: RecipeSummary[]
  onOpen: (id: string) => void
  onNew: () => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export function RecipeList({ recipes, onOpen, onNew }: Props) {
  return (
    <div className="view" data-testid="recipe-list">
      <header className="app-header">
        <h1>Longtable</h1>
        <button className="primary" data-testid="new-recipe" onClick={onNew}>
          + New recipe
        </button>
      </header>
      {recipes.length === 0 ? (
        <p className="empty">
          No recipes yet. Add your first one — everything stays on this device.
        </p>
      ) : (
        <ul className="recipe-cards">
          {recipes.map((r) => (
            <li key={r.id}>
              <button
                className="recipe-card"
                data-testid="recipe-item"
                onClick={() => onOpen(r.id)}
              >
                <span className="recipe-card-title">{r.title || 'Untitled'}</span>
                <span className="recipe-card-meta">{formatDate(r.updatedAt)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
