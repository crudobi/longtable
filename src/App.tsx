import { useCallback, useEffect, useRef, useState } from 'react'
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
import { ShareModal } from './components/ShareModal'
import { JoinModal } from './components/JoinModal'
import { onShareUpdate, rejoinShares, shareRecipe } from './p2p/share'
import type { SharePayload } from './p2p/share'
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
  const [sharePayload, setSharePayload] = useState<SharePayload | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const detailIdRef = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo)
    setSummaries(await listRecipes(index))
  }, [])

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

  useEffect(() => {
    detailIdRef.current = view.name === 'detail' ? view.id : null
  })

  useEffect(() => {
    refresh()
      .catch((e) => setError(String(e)))
      .finally(() => setReady(true))
    // Rejoin P2P shares (peers rediscover via signaling and sync converges).
    void rejoinShares().catch((e) => console.warn('rejoin shares failed', e))
    // Live refresh when a shared doc updates (local or remote edit).
    // Debounced: a burst of keystrokes or sync updates refreshes once.
    const unsubscribe = onShareUpdate(() => {
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
      refreshTimer.current = setTimeout(() => {
        void refresh()
        // If a detail view is open, re-read it so remote edits appear live.
        const id = detailIdRef.current
        if (id) void openDetail(id).catch(() => undefined)
      }, 800)
    })
    return () => {
      unsubscribe()
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [refresh, openDetail])


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

  const handleShare = useCallback(async (id: string) => {
    try {
      const summary = summaries.find((s) => s.id === id)
      const payload = await shareRecipe(id, summary?.title ?? 'Shared recipe')
      setSharePayload(payload)
    } catch (e) {
      setError(String(e))
    }
  }, [summaries])

  const handleJoined = useCallback(async () => {
    setJoinOpen(false)
    await refresh()
  }, [refresh])

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
          onJoin={() => setJoinOpen(true)}
        />
      )}
      {view.name === 'detail' && current && (
        <RecipeDetail
          recipe={current}
          onEdit={() => setView({ name: 'edit', id: view.id })}
          onDelete={() => void handleDelete(view.id)}
          onShare={() => void handleShare(view.id)}
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
      {sharePayload && (
        <ShareModal payload={sharePayload} onClose={() => setSharePayload(null)} />
      )}
      {joinOpen && (
        <JoinModal onJoined={() => void handleJoined()} onClose={() => setJoinOpen(false)} />
      )}
    </div>
  )
}
