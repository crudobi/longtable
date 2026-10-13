import type { Recipe } from '../types'

interface Props {
  recipe: Recipe
  onEdit: () => void
  onDelete: () => void
  onShare: () => void
  onShareFriends: () => void
  onBack: () => void
}

function formatMinutes(min?: number): string {
  return min === undefined ? '—' : `${min} min`
}

export function RecipeDetail({ recipe, onEdit, onDelete, onShare, onShareFriends, onBack }: Props) {
  return (
    <div className="view" data-testid="recipe-detail">
      <header className="app-header">
        <button className="ghost" data-testid="back-to-list" onClick={onBack}>
          ‹ Recipes
        </button>
        <div className="header-actions">
          <button data-testid="edit-recipe" onClick={onEdit}>
            Edit
          </button>
          <button className="danger" data-testid="delete-recipe" onClick={onDelete}>
            Delete
          </button>
          <button data-testid="share-recipe" onClick={onShare}>
            Share
          </button>
          <button data-testid="share-friends" onClick={onShareFriends}>
            Share with friends
          </button>
        </div>
      </header>

      <h1 className="detail-title" data-testid="recipe-title">
        {recipe.title || 'Untitled'}
      </h1>

      {recipe.visibility === 'friends-only' && (
        <p className="badge" data-testid="visibility-badge">
          Friends-only — encrypted for chosen friends
        </p>
      )}

      <div className="times">
        <span>
          Prep <strong>{formatMinutes(recipe.prepMinutes)}</strong>
        </span>
        <span>
          Cook <strong>{formatMinutes(recipe.cookMinutes)}</strong>
        </span>
      </div>

      {recipe.photos.length > 0 && (
        <div className="photo-strip">
          {recipe.photos.map((src, i) => (
            <img key={i} src={src} alt={`Recipe photo ${i + 1}`} loading="lazy" />
          ))}
        </div>
      )}

      <section>
        <h2>Ingredients</h2>
        {recipe.ingredients.length === 0 ? (
          <p className="empty">No ingredients listed.</p>
        ) : (
          <ul className="ingredients">
            {recipe.ingredients.map((ing, i) => (
              <li key={i}>{ing}</li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <h2>Steps</h2>
        {recipe.steps.length === 0 ? (
          <p className="empty">No steps listed.</p>
        ) : (
          <ol className="steps">
            {recipe.steps.map((step, i) => (
              <li key={i}>{step}</li>
            ))}
          </ol>
        )}
      </section>
    </div>
  )
}
