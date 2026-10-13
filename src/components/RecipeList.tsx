import type { RecipeSummary } from '../types'

interface Props {
  recipes: RecipeSummary[]
  onOpen: (id: string) => void
  onNew: () => void
  onJoin: () => void
  onFriends: () => void
  /** Open the importer panel (Phase 5: Importer API v1 front door). */
  onImport?: () => void
  /** Open the public-recipe discovery panel (Phase 3). */
  onDiscover?: () => void
  /** Open the hub settings (Phase 4). */
  onHubs?: () => void
  /** Open the developer settings (localhost API, E9). */
  onDeveloper?: () => void
}

function formatDate(iso: string): string {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString()
}

export function RecipeList({ recipes, onOpen, onNew, onJoin, onFriends, onImport, onDiscover, onHubs, onDeveloper }: Props) {
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
        {onImport && (
          <button data-testid="open-import" onClick={onImport}>
            Import
          </button>
        )}
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
        {onDeveloper && (
          <button data-testid="open-developer" onClick={onDeveloper}>
            Developer
          </button>
        )}
      </header>
      {recipes.length === 0 ? (
        <div className="empty empty-state" data-testid="cookbook-empty">
          <p>
            No recipes yet — this is your cookbook, and it lives on this
            device. No account, no cloud.
          </p>
          <p>
            Tap <strong>+ New recipe</strong> to write your first one, or{' '}
            <strong>Import</strong> to bring recipes in from a web page, a
            JSON file, or another app. When you're ready to share,{' '}
            <strong>Friends</strong> pairs you with another cook and{' '}
            <strong>Discover</strong> finds public recipes.
          </p>
        </div>
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
