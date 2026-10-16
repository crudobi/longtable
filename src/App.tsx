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
import { destroyAllShareProviders, onShareUpdate, rejoinShares, shareRecipe } from './p2p/share'
import type { SharePayload } from './p2p/share'
import { getOrCreateIdentity, type Identity } from './identity/identity'
import { disconnectAllFriendChannels, onChannelUpdate, rejoinFriendChannels } from './friends/friends'
import {
  importReceivedShares,
  installFriendsDebugHooks,
  republishIfShared,
  unshareRecipeEverywhere,
} from './friends/service'
import { FriendsPanel } from './components/FriendsPanel'
import { FriendShareModal } from './components/FriendShareModal'
import { PublishSettingsModal } from './components/PublishSettingsModal'
import { DiscoverPanel } from './components/DiscoverPanel'
import { ImportPanel } from './components/ImportPanel'
import { friendlyError } from './friendlyError'
import { DEBUG_HOOKS_ENABLED } from './debugHooks'
import { HubSettingsModal } from './components/HubSettingsModal'
import { LocalApiSettingsModal } from './components/LocalApiSettingsModal'
import { createLocalApiHost, LocalApiError } from './localapi/host'
import { setLocalApiHost, syncLocalApiServer } from './localapi/server'
import {
  AtprotoClient,
  loadAppViewUrl,
  loadSession,
  saveSession,
} from './public/atproto'
import {
  ensurePubkeyBinding,
  getPublication,
  publishRecipe,
  unpublishRecipe,
} from './public/publish'
import { searchAppView } from './public/discover'
import type { Recipe, RecipeInput, RecipeSummary, VisibilityTier } from './types'

/**
 * Thrown by applyVisibility when a recipe is asked to go public without
 * a publishing session. The UI catches it and opens the publishing
 * settings instead of reporting an error; the localhost API host maps
 * it to a plain 422 (nothing is written in either case).
 */
class VisibilitySessionError extends Error {
  constructor() {
    super('publishing sign-in needed')
    this.name = 'VisibilitySessionError'
  }
}

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
  const [identity, setIdentity] = useState<Identity | null>(null)
  const identityRef = useRef<Identity | null>(null)
  const [friendsOpen, setFriendsOpen] = useState(false)
  const [friendShareId, setFriendShareId] = useState<string | null>(null)
  const [publishSettingsOpen, setPublishSettingsOpen] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [hubsOpen, setHubsOpen] = useState(false)
  const [developerOpen, setDeveloperOpen] = useState(false)
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
      setError(friendlyError(e))
    }
  }, [])

  useEffect(() => {
    detailIdRef.current = view.name === 'detail' ? view.id : null
  })

  useEffect(() => {
    void (async () => {
      // One-time Phase 0 (Automerge) recovery migration: imports any
      // recipes orphaned by the Phase 1 storage swap. Flag-guarded and
      // dynamically imported, so it is inert after the first run.
      try {
        const { migrateFromAutomergeIfNeeded } = await import(
          './store/migrateFromAutomerge'
        )
        await migrateFromAutomergeIfNeeded()
      } catch (e) {
        console.warn('automerge migration failed', e)
      }
      // Phase 2 identity: load (or create) the device DID, rejoin friend
      // channels, and import any friends-only shares waiting in them.
      try {
        const id = await getOrCreateIdentity()
        identityRef.current = id
        setIdentity(id)
        if (DEBUG_HOOKS_ENABLED) installFriendsDebugHooks(id)
        await rejoinFriendChannels()
        await importReceivedShares(id).catch((e) =>
          console.warn('import received shares failed', e),
        )
      } catch (e) {
        console.warn('identity setup failed', e)
      }
      await refresh()
    })()
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setReady(true))
    // Rejoin P2P shares (peers rediscover via signaling and sync converges).
    void rejoinShares().catch((e) => console.warn('rejoin shares failed', e))
    // Friends-only channel updates: a friend published or republished a
    // share — decrypt what's addressed to me and refresh.
    let channelTimer: ReturnType<typeof setTimeout> | null = null
    const unsubChannel = onChannelUpdate(() => {
      const id = identityRef.current
      if (!id) return
      if (channelTimer) clearTimeout(channelTimer)
      channelTimer = setTimeout(() => {
        void importReceivedShares(id)
          .then(() => refresh())
          .catch((e) => console.warn('channel import failed', e))
      }, 800)
    })
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
      unsubChannel()
      if (channelTimer) clearTimeout(channelTimer)
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

  /**
   * The content-update flow itself, without UI navigation: store update
   * plus the two republishes (friends-only share, public record). Used
   * by the edit form AND the localhost API, so an API update takes
   * exactly the UI's path.
   */
  const applyRecipeUpdate = useCallback(
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
      // If this recipe is shared friends-only, republish the new version
      // (encrypted, same key) to its authorized friends.
      const idn = identityRef.current
      if (idn) {
        await republishIfShared(id, idn).catch((e) =>
          console.warn('republish failed', e),
        )
      }
      // If this recipe is public with a live publication, republish the
      // fresh content (new blobs + a fresh device signature) to the PDS.
      if (idn) {
        try {
          const session = loadSession()
          if (session && getPublication(id)) {
            const entry = (await index.doc())?.recipes[id]
            const fresh = entry ? await getRecipe(repo, entry.url) : null
            if (fresh && fresh.visibility === 'public') {
              const client = new AtprotoClient(session.pdsUrl, {
                onSessionRefresh: (s) => saveSession(s),
              })
              await publishRecipe(client, session, idn, { ...fresh, id })
            }
          }
        } catch (e) {
          console.warn('public republish failed', e)
        }
      }
    },
    [],
  )

  const handleUpdate = useCallback(
    async (id: string, input: RecipeInput) => {
      await applyRecipeUpdate(id, input)
      await refresh()
      await openDetail(id)
    },
    [applyRecipeUpdate, refresh, openDetail],
  )

  /**
   * The delete flow itself, without the confirmation prompt or UI
   * navigation: strip friends-only shares, remove the public record,
   * then delete locally. Used by the detail view AND the localhost API.
   */
  const performDelete = useCallback(async (id: string) => {
    // Strip friends-only shares of this recipe from friends' channels.
    const idn = identityRef.current
    if (idn) {
      await unshareRecipeEverywhere(id, idn).catch((e) =>
        console.warn('unshare failed', e),
      )
    }
    // If it was published publicly, remove the ATProto record first.
    if (getPublication(id)) {
      const session = loadSession()
      if (session) {
        await unpublishRecipe(new AtprotoClient(session.pdsUrl), session, id).catch(
          (e) => console.warn('unpublish failed', e),
        )
      }
    }
    const repo = getRepo()
    const index = await getOrCreateIndex(repo)
    await deleteRecipe(repo, index, id)
  }, [])

  const handleDelete = useCallback(
    async (id: string) => {
      const summary = summaries.find((s) => s.id === id)
      const name = summary?.title || 'this recipe'
      if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return
      await performDelete(id)
      await refresh()
      setView({ name: 'list' })
    },
    [summaries, performDelete, refresh],
  )

  const loadRecipeById = useCallback(async (id: string): Promise<Recipe | null> => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo)
    const entry = (await index.doc())?.recipes[id]
    if (!entry) return null
    return getRecipe(repo, entry.url)
  }, [])

  /**
   * Visibility switching — the real byte movement between tiers:
   *   → public:      requires an ATProto session (no session →
   *                  VisibilitySessionError; the UI wrapper opens the
   *                  publishing settings, the localhost API answers a
   *                  plain 422 — tier unchanged either way); ensure the
   *                  pubkey binding, publish the signed record to the
   *                  PDS, only then mark the recipe 'public'.
   *   → private:     unpublish the ATProto record first (if any); strip
   *                  friends-only shares everywhere (if friends-only);
   *                  then mark 'private'.
   *   → friends-only: unpublish the ATProto record first (if any); mark
   *                  'friends-only'. (Choosing friends and publishing
   *                  the encrypted shares is the friend picker's job —
   *                  the UI wrapper opens it after this runs.)
   * Shared by the detail view and the localhost API host.
   */
  const applyVisibility = useCallback(
    async (id: string, recipe: Recipe, tier: VisibilityTier) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      const idn = identityRef.current
      const publication = getPublication(id)
      const unpublishIfNeeded = async () => {
        if (!publication) return
        const session = loadSession()
        if (!session) return
        const client = new AtprotoClient(session.pdsUrl, {
          onSessionRefresh: (s) => saveSession(s),
        })
        await unpublishRecipe(client, session, id)
      }

      if (tier === 'public') {
        const session = loadSession()
        if (!session || !idn) throw new VisibilitySessionError()
        const client = new AtprotoClient(session.pdsUrl, {
          onSessionRefresh: (s) => saveSession(s),
        })
        await ensurePubkeyBinding(client, session, idn)
        await publishRecipe(client, session, idn, { ...recipe, id })
        await updateRecipe(repo, index, id, { visibility: 'public' })
      } else if (tier === 'private') {
        await unpublishIfNeeded()
        if (recipe.visibility === 'friends-only' && idn) {
          await unshareRecipeEverywhere(id, idn)
        }
        await updateRecipe(repo, index, id, { visibility: 'private' })
      } else {
        await unpublishIfNeeded()
        await updateRecipe(repo, index, id, { visibility: 'friends-only' })
      }
    },
    [],
  )

  const handleSetVisibility = useCallback(
    async (id: string, recipe: Recipe, tier: VisibilityTier) => {
      try {
        setError(null)
        await applyVisibility(id, recipe, tier)
        await refresh()
        await openDetail(id)
        if (tier === 'friends-only') setFriendShareId(id)
      } catch (e) {
        if (e instanceof VisibilitySessionError) {
          setPublishSettingsOpen(true)
          return
        }
        setError(friendlyError(e, 'the publishing server'))
      }
    },
    [applyVisibility, refresh, openDetail],
  )

  const handleSetVisibilityRef = useRef(handleSetVisibility)
  handleSetVisibilityRef.current = handleSetVisibility

  // Refs to the extracted flows, for the localhost API host below (the
  // host is configured once, the refs keep it on the latest callbacks).
  const applyRecipeUpdateRef = useRef(applyRecipeUpdate)
  applyRecipeUpdateRef.current = applyRecipeUpdate
  const performDeleteRef = useRef(performDelete)
  performDeleteRef.current = performDelete
  const applyVisibilityRef = useRef(applyVisibility)
  applyVisibilityRef.current = applyVisibility

  // Phase 3 debug hooks (e2e proof): window.__ltPublic, installed when the
  // device identity lands — same pattern as installFriendsDebugHooks.
  // Gated by DEBUG_HOOKS_ENABLED (src/debugHooks.ts): CI proof builds
  // only; the published artifact never installs this.
  useEffect(() => {
    if (!identity || !DEBUG_HOOKS_ENABLED) return
    const w = window as unknown as { __ltPublic?: unknown }
    w.__ltPublic = {
      getSession: () => loadSession(),
      publishById: async (id: string) => {
        const session = loadSession()
        if (!session) throw new Error('no ATProto session')
        const rec = await loadRecipeById(id)
        if (!rec) throw new Error(`recipe not found: ${id}`)
        const client = new AtprotoClient(session.pdsUrl, {
          onSessionRefresh: (s) => saveSession(s),
        })
        return publishRecipe(client, session, identity, { ...rec, id })
      },
      unpublishById: async (id: string) => {
        const session = loadSession()
        if (!session) throw new Error('no ATProto session')
        const client = new AtprotoClient(session.pdsUrl, {
          onSessionRefresh: (s) => saveSession(s),
        })
        await unpublishRecipe(client, session, id)
      },
      setVisibilityById: async (id: string, tier: VisibilityTier) => {
        const rec = await loadRecipeById(id)
        if (!rec) throw new Error(`recipe not found: ${id}`)
        await handleSetVisibilityRef.current(id, rec, tier)
      },
      search: (q?: string, ingredients?: string[] | string) =>
        searchAppView(loadAppViewUrl(), { q, ingredients }),
    }
  }, [identity, loadRecipeById])

  // Localhost API (E9): register the host the API router executes
  // against — wired to the very flows the UI uses, so an API write
  // republishes/unpublishes/unshares exactly like an in-app one — and
  // start the loopback server if the user enabled it in Developer
  // settings. Runs when the identity lands; the server then lives and
  // dies with the app process.
  useEffect(() => {
    if (!identity) return
    setLocalApiHost(
      createLocalApiHost({
        applyUpdate: (id, input) => applyRecipeUpdateRef.current(id, input),
        applyDelete: (id) => performDeleteRef.current(id),
        applyVisibility: async (id, recipe, tier) => {
          try {
            await applyVisibilityRef.current(id, recipe, tier)
          } catch (e) {
            if (e instanceof VisibilitySessionError) {
              throw new LocalApiError(
                422,
                "That recipe can't be made public yet: no publishing " +
                  'account is signed in on this device. Sign in under ' +
                  'Publishing in the app first.',
              )
            }
            throw e
          }
        },
        canPublish: () => loadSession() != null,
        getIdentityDid: async () => identityRef.current?.did ?? null,
        onChanged: () => {
          void refresh()
        },
      }),
    )
    void syncLocalApiServer().catch((e) =>
      console.warn('localhost API start failed', e),
    )
  }, [identity, refresh])

  /**
   * Bulk import (Import panel): recipes arrive fully validated by the
   * importer registry, so creation here is a straight loop — then one
   * refresh. No navigation: the panel reports the imported titles.
   */
  const handleImportRecipes = useCallback(
    async (inputs: RecipeInput[]) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      for (const input of inputs) {
        await createRecipe(repo, index, input)
      }
      await refresh()
    },
    [refresh],
  )

  const handleShare = useCallback(async (id: string) => {
    try {
      const summary = summaries.find((s) => s.id === id)
      const payload = await shareRecipe(id, summary?.title ?? 'Shared recipe')
      setSharePayload(payload)
    } catch (e) {
      setError(friendlyError(e))
    }
  }, [summaries])

  /**
   * Hub list/active hub changed (Phase 4): rebuild every network provider
   * against the new endpoints. Providers are the ONLY thing rebuilt — docs,
   * share records, friends, and identity are hub-independent, so the switch
   * loses nothing.
   */
  const handleHubsChanged = useCallback(async () => {
    destroyAllShareProviders()
    disconnectAllFriendChannels()
    await rejoinShares().catch((e) => console.warn('rejoin shares after hub change failed', e))
    await rejoinFriendChannels().catch((e) =>
      console.warn('rejoin friend channels after hub change failed', e),
    )
  }, [])

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
          onFriends={() => setFriendsOpen(true)}
          onImport={() => setImportOpen(true)}
          onDiscover={() => setDiscoverOpen(true)}
          onHubs={() => setHubsOpen(true)}
          onDeveloper={() => setDeveloperOpen(true)}
        />
      )}
      {view.name === 'detail' && current && (
        <RecipeDetail
          recipe={current}
          onEdit={() => setView({ name: 'edit', id: view.id })}
          onDelete={() => void handleDelete(view.id)}
          onShare={() => void handleShare(view.id)}
          onShareFriends={() => setFriendShareId(view.id)}
          onBack={() => setView({ name: 'list' })}
          onSetVisibility={(r, tier) => void handleSetVisibility(view.id, r, tier)}
          onOpenPublishSettings={() => setPublishSettingsOpen(true)}
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
      {friendsOpen && identity && (
        <FriendsPanel
          identity={identity}
          onClose={() => setFriendsOpen(false)}
          onOpenRecipe={(localId) => void openDetail(localId)}
          onChanged={() => void refresh()}
        />
      )}
      {publishSettingsOpen && (
        <PublishSettingsModal
          identity={identity}
          onClose={() => setPublishSettingsOpen(false)}
        />
      )}
      {importOpen && (
        <ImportPanel
          onClose={() => setImportOpen(false)}
          onImported={handleImportRecipes}
        />
      )}
      {discoverOpen && (
        <DiscoverPanel
          onClose={() => setDiscoverOpen(false)}
          onSaveCopy={handleCreate}
        />
      )}
      {hubsOpen && (
        <HubSettingsModal
          onClose={() => setHubsOpen(false)}
          onChanged={() => void handleHubsChanged()}
        />
      )}
      {developerOpen && (
        <LocalApiSettingsModal onClose={() => setDeveloperOpen(false)} />
      )}
      {friendShareId && identity && (
        <FriendShareModal
          recipeId={friendShareId}
          recipeTitle={summaries.find((r) => r.id === friendShareId)?.title ?? 'recipe'}
          identity={identity}
          onClose={() => setFriendShareId(null)}
          onDone={() => {
            setFriendShareId(null)
            void refresh()
          }}
        />
      )}
    </div>
  )
}
