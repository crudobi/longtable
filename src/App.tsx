import { useCallback, useEffect, useState } from 'react'
import { getRepo } from './store/repo'
import {
  createRecipe,
  deleteRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  updateRecipe,
} from './store/recipes'
import { RecipeList } from './components/RecipeList'
import { RecipeDetail } from './components/RecipeDetail'
import { RecipeForm } from './components/RecipeForm'
import type { Recipe, RecipeInput, RecipeSummary } from './types'

type View =
  | { name: 'list' }
  | { name: 'detail'; id: string }
  | { name: 'new' }
  | { name: 'edit'; id: string }

const emptyInput: RecipeInput = { title: '', ingredients: [], steps: [], photos: [] }

export default function App() {
  const [view, setView] = useState<View>({ name: 'list' })
  const [summaries, setSummaries] = useState<RecipeSummary[]>([])
  const [current, setCurrent] = useState<Recipe | null>(null)
  const [ready, setReady] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo)
    setSummaries(await listRecipes(index))
  }, [])

  useEffect(() => {
    refresh()
      .catch((e) => setError(String(e)))
      .finally(() => setReady(true))
  }, [refresh])

  const openDetail = useCallback(async (id: string) => {
    try {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      const idxDoc = await index.doc()
      const entry = idxDoc?.recipes[id]
      if (!entry) return
      const recipe = await getRecipe(repo, entry.url)
      if (!recipe) return
      setCurrent(recipe)
      setView({ name: 'detail', id })
      window.scrollTo(0, 0)
    } catch (e) {
      setError(String(e))
    }
  }, [])

  const handleCreate = useCallback(
    async (input: RecipeInput) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      const summary = await createRecipe(repo, index, input)
      await refresh()
      await openDetail(summary.id)
    },
    [refresh, openDetail],
  )

  const handleUpdate = useCallback(
    async (id: string, input: RecipeInput) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      await updateRecipe(repo, index, id, {
        title: input.title,
        ingredients: input.ingredients,
        steps: input.steps,
        photos: input.photos,
        prepMinutes: input.prepMinutes,
        cookMinutes: input.cookMinutes,
      })
      await refresh()
      await openDetail(id)
    },
    [refresh, openDetail],
  )

  const handleDelete = useCallback(
    async (id: string) => {
      const summary = summaries.find((s) => s.id === id)
      const name = summary?.title || 'this recipe'
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      await deleteRecipe(repo, index, id)
      await refresh()
      setView({ name: 'list' })
    },
    [summaries, refresh],
  )

  if (!ready) {
    return (
      <div className="view">
        <p className="empty">Loading your recipes…</p>
      </div>
    )
  }

  return (
    <div className="app">
      {error && <p className="status error">{error}</p>}
      {view.name === 'list' && (
        <RecipeList
          recipes={summaries}
          onOpen={openDetail}
          onNew={() => setView({ name: 'new' })}
        />
      )}
      {view.name === 'detail' && current && (
        <RecipeDetail
          recipe={current}
          onEdit={() => setView({ name: 'edit', id: view.id })}
          onDelete={() => void handleDelete(view.id)}
          onBack={() => setView({ name: 'list' })}
        />
      )}
      {view.name === 'new' && (
        <RecipeForm
          initial={emptyInput}
          heading="New recipe"
          onSave={(input) => void handleCreate(input)}
          onCancel={() => setView({ name: 'list' })}
        />
      )}
      {view.name === 'edit' && current && (
        <RecipeForm
          initial={{
            title: current.title,
            ingredients: current.ingredients,
            steps: current.steps,
            photos: current.photos,
            prepMinutes: current.prepMinutes,
            cookMinutes: current.cookMinutes,
          }}
          heading="Edit recipe"
          onSave={(input) => void handleUpdate(view.id, input)}
          onCancel={() => void openDetail(view.id)}
        />
      )}
    </div>
  )
}
