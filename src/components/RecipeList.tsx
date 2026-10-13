import type { RecipeSummary } from '../types'

interface Props {
  recipes: RecipeSummary[]
  onOpen: (id: string) => void
  onNew: () => void
  onJoin: () => void
  onFriends: () => void
  /** Open the public-recipe discovery panel (Phase 3). */
  onDiscover?: () => void
  /** Open the hub settings (Phase 4). */
  onHubs?: () => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export function RecipeList({ recipes, onOpen, onNew, onJoin, onFriends, onDiscover, onHubs }: Props) {
  return (
    <div className="view" data-testid="recipe-list">
      <header className="app-header">
        <h1>Longtable</h1>
        <button className="primary" data-testid="new-recipe" onClick={onNew}>
          + New recipe
        </button>
        <button data-testid="join-recipe" onClick={onJoin}>
          Join shared
        </button>
        <button data-testid="friends-open" onClick={onFriends}>
          Friends
        </button>
        {onDiscover && (
          <button data-testid="open-discover" onClick={onDiscover}>
            Discover
          </button>
        )}
        {onHubs && (
          <button data-testid="open-hubs" onClick={onHubs}>
            Hubs
          </button>
        )}
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
