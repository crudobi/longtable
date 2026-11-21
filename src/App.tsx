import { useCallback, useEffect, useRef, useState } from 'react'
import { getRepo, registerPagehideFlush } from './store/repo'
import {
  createRecipe,
  createRecipesAtomic,
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
import {
  destroyAllShareProviders,
  leaveShare,
  loadShares,
  onShareUpdate,
  rejoinShares,
  shareRecipe,
} from './p2p/share'
import {
  applyVisibilityFlow,
  performDeleteFlow,
  VisibilitySessionError,
} from './recipeFlows'
import type { SharePayload } from './p2p/share'
import {
  IDENTITY_SECRET_KEY,
  IdentityDamagedError,
  getOrCreateIdentity,
  type Identity,
} from './identity/identity'
import { disconnectAllFriendChannels, listFriends, onChannelUpdate, rejoinFriendChannels } from './friends/friends'
import {
  importReceivedShares,
  installFriendsDebugHooks,
  loadReceivedMap,
  republishIfShared,
  sweepFriendsOnlyShares,
} from './friends/service'
import { loadVault } from './friends/shelf'
import { listHubs } from './hubs/hubs'
import { loadLocalApiSettings } from './localapi/settings'
import {
  corruptStoreLabel,
  discardCorruptStore,
  listCorruptStores,
  type CorruptStoreEntry,
} from './store/corrupt'
import { FriendsPanel } from './components/FriendsPanel'
import { FriendShareModal } from './components/FriendShareModal'
import { PublishSettingsModal } from './components/PublishSettingsModal'
import { DiscoverPanel } from './components/DiscoverPanel'
import { ImportPanel } from './components/ImportPanel'
import { BackupPanel } from './components/BackupPanel'
import { friendlyError } from './friendlyError'
import { addStartupNotice, type StartupFailureKind } from './startupNotices'
import { DEBUG_HOOKS_ENABLED } from './debugHooks'
import {
  flushSecrets,
  initSecrets,
  isSecureStoreAvailable,
  lastInitReport,
  readSecureStoreRaw,
  secretKv,
  secretsStatus,
} from './secrets/secretStore'
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
import { getPublication, loadPublications, publishRecipe, unpublishRecipe } from './public/publish'
import { searchAppView } from './public/discover'
import type { Recipe, RecipeInput, RecipeSummary, VisibilityTier } from './types'

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
  // Rel L6: non-blocking startup banner. Background jobs that fail at
  // startup (secret migration, index cleanup, share rejoin, …) append
  // a plain-language notice here instead of failing console-only.
  // The app keeps working; the banner dismisses.
  const [startupNotices, setStartupNotices] = useState<string[]>([])
  const addNotice = useCallback((kind: StartupFailureKind) => {
    setStartupNotices((xs) => addStartupNotice(xs, kind))
  }, [])
  const [sharePayload, setSharePayload] = useState<SharePayload | null>(null)
  const [joinOpen, setJoinOpen] = useState(false)
  const [identity, setIdentity] = useState<Identity | null>(null)
  const identityRef = useRef<Identity | null>(null)
  // H8: the stored identity secret is damaged — the app is blocked on
  // the identity-damaged screen until the user restores from a backup.
  // H9: stores whose saved JSON could not be read (quarantined, never
  // overwritten) — shown as a banner with a recovery action each.
  const [identityDamaged, setIdentityDamaged] = useState<IdentityDamagedError | null>(null)
  const [corruptStores, setCorruptStores] = useState<CorruptStoreEntry[]>([])
  const [friendsOpen, setFriendsOpen] = useState(false)
  const [friendShareId, setFriendShareId] = useState<string | null>(null)
  const [publishSettingsOpen, setPublishSettingsOpen] = useState(false)
  const [discoverOpen, setDiscoverOpen] = useState(false)
  const [importOpen, setImportOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
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
      // Wave 3 (Keystore): move legacy localStorage secrets into the
      // Android Keystore BEFORE anything reads them (identity load
      // below). Reports per-key outcomes; degraded mode keeps the app
      // working from localStorage when the Keystore is unavailable.
      try {
        const report = await initSecrets()
        // Outcomes only (per-key outcome + legacyCleared boolean) — no
        // secret values ever reach the log.
        console.log('[longtable] secret migration', JSON.stringify(report))
        if (!report.secureAvailable) {
          console.warn(
            '[longtable] keystore unavailable — secrets stay in localStorage',
            report.perKey,
          )
        }
      } catch (e) {
        console.warn('secret migration failed', e)
        addNotice('secrets-migration')
      }
      // One-time Phase 0 (Automerge) recovery migration: imports any
      // recipes orphaned by the Phase 1 storage swap. Flag-guarded and
      // dynamically imported, so it is inert after the first run. A run
      // with failed documents does NOT set the flag (it retries next
      // launch) and the user is told once per failed set (M14).
      try {
        const { migrateFromAutomergeIfNeeded, migrationFailureNotice } = await import(
          './store/migrateFromAutomerge'
        )
        const outcome = await migrateFromAutomergeIfNeeded()
        const notice = migrationFailureNotice(outcome)
        if (notice) setError(notice)
      } catch (e) {
        console.warn('automerge migration failed', e)
        addNotice('automerge-migration')
      }
      // Startup index-integrity pass (M11/M13): drop index entries
      // whose recipe document is gone or empty (the crash window the
      // index-first create leaves behind) and malformed entries the
      // snapshot drops. Runs before the first refresh below.
      try {
        const { reconcileIndexOrphans } = await import('./store/recipes')
        await reconcileIndexOrphans(getRepo())
      } catch (e) {
        console.warn('startup index cleanup failed', e)
        addNotice('index-cleanup')
      }
      // Phase 2 identity: load (or create) the device DID, rejoin friend
      // channels, and import any friends-only shares waiting in them.
      // H8: a damaged stored secret throws IdentityDamagedError — the
      // app does NOT mint a fresh DID (that would orphan friends +
      // published recipes) and does NOT proceed as if identity-less:
      // the blocking screen takes over until the user restores.
      let damaged: IdentityDamagedError | null = null
      try {
        const id = await getOrCreateIdentity()
        identityRef.current = id
        setIdentity(id)
        if (DEBUG_HOOKS_ENABLED) installFriendsDebugHooks(id)
        await rejoinFriendChannels()
        await importReceivedShares(id).catch((e) => {
          console.warn('import received shares failed', e)
          addNotice('received-shares-import')
        })
        // M1-rel / M-N4: finish any interrupted unfriend, then sweep
        // every friend's shelf so each holds only their own current
        // shares. Best-effort: a failed sweep is logged, never fatal.
        await sweepFriendsOnlyShares(id).catch((e) => {
          console.warn('friends-only sweep failed', e)
          addNotice('friends-sweep')
        })
      } catch (e) {
        if (e instanceof IdentityDamagedError) {
          damaged = e
          setIdentityDamaged(e)
        } else {
          console.warn('identity setup failed', e)
          addNotice('identity-setup')
        }
      }
      // H9: probe every JSON store once, so corruption in a store
      // nothing else reads at startup (key vault, publications, API
      // settings) still surfaces in the banner instead of waiting for
      // the first write to it. The loads are cheap sync reads; a
      // damaged store reads as its safe empty view.
      if (!damaged) {
        listFriends()
        loadVault()
        loadShares()
        loadReceivedMap(secretKv)
        listHubs()
        loadPublications()
        loadLocalApiSettings()
        setCorruptStores(listCorruptStores())
      }
      await refresh()
    })()
      .catch((e) => setError(friendlyError(e)))
      .finally(() => setReady(true))
    // Integrity M12: flush pending IndexedDB writes when the page is
    // hidden, so a kill right after a mutation does not lose the write.
    const stopPagehideFlush = registerPagehideFlush(getRepo())
    // Rejoin P2P shares (peers rediscover via signaling and sync converges).
    void rejoinShares().catch((e) => {
      console.warn('rejoin shares failed', e)
      addNotice('rejoin-shares')
    })
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
      stopPagehideFlush()
      if (channelTimer) clearTimeout(channelTimer)
      if (refreshTimer.current) clearTimeout(refreshTimer.current)
    }
  }, [refresh, openDetail, addNotice])


  const handleCreate = useCallback(
    async (
      input: RecipeInput,
      timestamps?: { createdAt?: string; updatedAt?: string },
    ) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      // Timestamps pass through only from save-a-copy (the original
      // recipe's history, preserved); a fresh recipe stamps "now".
      const summary = await createRecipe(repo, index, input, timestamps)
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
      const stale: string[] = []
      if (idn) {
        await republishIfShared(id, idn).catch((e) => {
          console.warn('republish failed', e)
          stale.push('the copy shared with your friends')
        })
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
          stale.push('the public copy')
        }
      }
      // The local save stands either way — but a failed republication is
      // never silent: the user hears that a shared/public copy may still
      // show the older version.
      if (stale.length > 0) {
        setError(
          `Saved on this device — but ${stale.join(' and ')} couldn't be updated just now, so ${stale.length === 1 ? 'it' : 'they'} may still show the older version.`,
        )
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
   * navigation — see performDeleteFlow in recipeFlows.ts (strip
   * friends-only shares, remove the public record, leave the P2P room,
   * then delete locally). Used by the detail view AND the localhost API.
   * The local delete always proceeds — deleting here is the user's act —
   * but if a remote removal fails, the user is told plainly that the
   * shared/public copy may still be live; it is never swallowed quietly.
   * Returns the flow's warnings (H13) so the API host can surface them.
   */
  const performDelete = useCallback(async (id: string): Promise<string[]> => {
    const warnings = await performDeleteFlow(id, {
      identity: identityRef.current,
    })
    if (warnings.length > 0) {
      setError(warnings.join(' '))
    }
    return warnings
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
   * Visibility switching — see applyVisibilityFlow in recipeFlows.ts for
   * the real byte movement between tiers (public needs a session and
   * publishes first; private/friends-only unpublish, strip friends-only
   * shares, leave the P2P room, then mark the tier). Shared by the detail
   * view and the localhost API host.
   */
  const applyVisibility = useCallback(
    async (id: string, recipe: Recipe, tier: VisibilityTier): Promise<string[]> => {
      return applyVisibilityFlow(id, recipe, tier, {
        identity: identityRef.current,
      })
    },
    [],
  )

  const handleSetVisibility = useCallback(
    async (id: string, recipe: Recipe, tier: VisibilityTier) => {
      // Going public is the one wide-exposure move in the app, so — like
      // delete and unfriend — it confirms first, with the consequence in
      // plain words. Private and friends-only stay one tap, and leaving
      // public (which only removes exposure) stays one tap too.
      if (tier === 'public' && recipe.visibility !== 'public') {
        const name = recipe.title || 'this recipe'
        if (
          !window.confirm(
            `Make "${name}" public? Anyone with Longtable can find and read it, and it will be listed under your publishing account. You can make it private again later — but copies other people have saved stay theirs.`,
          )
        ) {
          return
        }
      }
      try {
        setError(null)
        const warnings = await applyVisibility(id, recipe, tier)
        await refresh()
        await openDetail(id)
        if (warnings.length > 0) {
          // H13: a flip that leaves a remote copy live (or recalls
          // friends' copies only on sync) says so, like the delete
          // flow does — the tier changed, but the caller is told.
          setError(warnings.join(' '))
        }
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

  // Wave 3 debug hooks (e2e proof): window.__ltSecrets, installed once
  // at mount — same pattern as __ltPublic. Gated by
  // DEBUG_HOOKS_ENABLED (src/debugHooks.ts): CI proof builds only; the
  // published artifact never installs this. readSecret answers from
  // the in-memory mirror (the app's read path); readSecureStore reads
  // the Keystore directly (the migration proof's backing check).
  // Values are exposed only to the proof harness in debug builds —
  // the proof scripts report presence booleans and digests, never
  // values. flush() drains the async Keystore persist queue before
  // a proof force-stops the app.
  useEffect(() => {
    if (!DEBUG_HOOKS_ENABLED) return
    const w = window as unknown as { __ltSecrets?: unknown }
    w.__ltSecrets = {
      available: () => isSecureStoreAvailable(),
      initReport: () => lastInitReport(),
      status: () => secretsStatus(),
      readSecret: (key: string) => secretKv.getItem(key),
      readSecureStore: (key: string) => readSecureStoreRaw(key),
      localStorageHas: (key: string) => {
        try {
          return localStorage.getItem(key) !== null
        } catch {
          return false
        }
      },
      flush: () => flushSecrets(),
    }
  }, [])

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
            return await applyVisibilityRef.current(id, recipe, tier)
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
    void syncLocalApiServer().catch((e) => {
      console.warn('localhost API start failed', e)
      addNotice('local-api-start')
    })
  }, [identity, refresh, addNotice])

  /**
   * Bulk import (Import panel): recipes arrive fully validated by the
   * importer registry, so creation here is atomic, best-effort (H11) —
   * a mid-loop store failure rolls back what was already created and
   * says so, instead of leaving a partial import behind. No navigation:
   * the panel reports the imported titles.
   */
  const handleImportRecipes = useCallback(
    async (inputs: RecipeInput[]) => {
      const repo = getRepo()
      const index = await getOrCreateIndex(repo)
      try {
        await createRecipesAtomic(repo, index, inputs)
      } catch (e) {
        setError(friendlyError(e))
        return
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
   * "Stop sharing" from the share modal: leave the P2P room without
   * deleting the recipe (leaveShare destroys the provider and deletes
   * the share record; the recipe stays). One tap, like the private flip
   * — re-sharing is one tap too.
   */
  const handleStopSharing = useCallback(async (id: string) => {
    try {
      leaveShare(id)
    } catch (e) {
      setError(friendlyError(e))
      return
    }
    setSharePayload(null)
    await refresh()
  }, [refresh])

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

  /**
   * H9: discard one damaged store's live value, after an explicit
   * confirm. The quarantine copy keeps the bytes, so this loses
   * nothing recoverable; the store heals to its absent/default state
   * (re-enter hubs, re-publish, re-enable the API, or restore from
   * backup afterwards). Never offered for the identity key — the
   * blocking identity-damaged screen is the only identity-damage UI.
   */
  const handleDiscardCorrupt = useCallback(
    (entry: CorruptStoreEntry) => {
      if (entry.key === IDENTITY_SECRET_KEY) return
      const label = corruptStoreLabel(entry.key)
      if (
        !window.confirm(
          `Discard the damaged ${label}? The damaged copy is preserved under ${entry.quarantineKey}, ` +
            `but this device will forget the ${label} as it was — you will need to re-enter it, or restore it from a backup.`,
        )
      ) {
        return
      }
      discardCorruptStore(secretKv, entry.key)
      setCorruptStores(listCorruptStores())
      void refresh()
    },
    [refresh],
  )

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

  // H8: blocking identity-damaged state. The stored identity key is
  // unreadable, and no fresh identity was minted — minting one would
  // orphan every friend and published recipe. Nothing identity-shaped
  // runs from here (no pairing, publishing, sharing, or localhost
  // API); the only way forward is restoring from an encrypted backup,
  // which replaces the damaged key with the backed-up one and reloads
  // the app. Recipes on this device are untouched by the damage, and
  // the damaged key itself was preserved (quarantine key below).
  if (identityDamaged) {
    return (
      <div className="app">
        <div className="view">
          <h2>Your device identity is damaged</h2>
          <p>
            The key that identifies this device could not be read
            ({identityDamaged.reason}). A new identity was <strong>not</strong>{' '}
            created: a new one would look like a stranger to your friends
            and to your published recipes, and the old connections could
            not be recovered.
          </p>
          <p>
            The damaged key was preserved, not deleted (
            <code>{identityDamaged.quarantineKey}</code>).
          </p>
          <p>
            <strong>Restore from an encrypted backup</strong> to recover
            your identity, friends, and shares. If you have no backup
            file, the previous identity — and the friend connections
            tied to it — cannot be recovered.
          </p>
          <div className="modal-actions">
            <button
              className="primary"
              data-testid="identity-damaged-restore"
              onClick={() => setBackupOpen(true)}
            >
              Restore from backup
            </button>
          </div>
          {backupOpen && (
            <BackupPanel
              identity={null}
              onClose={() => setBackupOpen(false)}
              onRestored={() => void refresh()}
            />
          )}
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      {error && <p className="status error">{error}</p>}
      {startupNotices.length > 0 && (
        <div className="status" data-testid="startup-notices">
          <strong>Something didn’t finish at startup.</strong>{' '}
          The cookbook itself is fine — but:
          <ul>
            {startupNotices.map((n) => (
              <li key={n}>{n}</li>
            ))}
          </ul>
          <div className="modal-actions">
            <button
              className="ghost"
              data-testid="dismiss-startup-notices"
              onClick={() => setStartupNotices([])}
            >
              Dismiss
            </button>
          </div>
        </div>
      )}
      {corruptStores.length > 0 && (
        <div className="status error" data-testid="corrupt-stores-banner">
          <strong>Some saved data could not be read.</strong>{' '}
          The original data was preserved and nothing was overwritten.
          Restore from an encrypted backup to recover it.
          <ul>
            {corruptStores.map((entry) => (
              <li key={entry.key}>
                {corruptStoreLabel(entry.key)} — damaged (
                {entry.reason}); preserved as{' '}
                <code>{entry.quarantineKey}</code>.{' '}
                <button
                  className="ghost"
                  data-testid={`discard-corrupt-${entry.key}`}
                  onClick={() => handleDiscardCorrupt(entry)}
                >
                  Discard damaged copy
                </button>
              </li>
            ))}
          </ul>
          <div className="modal-actions">
            <button
              className="primary"
              data-testid="corrupt-stores-restore"
              onClick={() => setBackupOpen(true)}
            >
              Open backup &amp; restore
            </button>
          </div>
        </div>
      )}
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
          onBackup={identity ? () => setBackupOpen(true) : undefined}
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
          onSave={handleCreate}
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
          onSave={(input) => handleUpdate(view.id, input)}
          onCancel={() => void openDetail(view.id)}
        />
      )}
      {sharePayload && (
        <ShareModal
          payload={sharePayload}
          onClose={() => setSharePayload(null)}
          onStopSharing={() => void handleStopSharing(sharePayload.recipeId)}
        />
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
      {backupOpen && identity && (
        <BackupPanel
          identity={identity}
          onClose={() => setBackupOpen(false)}
          onRestored={() => void refresh()}
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
