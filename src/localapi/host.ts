/**
 * LocalApiHost — the seam between the localhost API and the app.
 *
 * The router (router.ts) talks only to this interface, so unit tests can
 * drive the whole HTTP surface against a store-backed host on an
 * in-memory repo. The real host — built by `createLocalApiHost` and
 * wired up in App — executes against the actual store and, for the
 * operations that have side paths, through the SAME functions the UI
 * uses: content updates republish to friends/PDS, deletes unshare +
 * unpublish first, and visibility flips move the real bytes
 * (publish/unpublish). The API never gets a private shortcut around
 * those paths, and it never sees key material: the friends surface is
 * names + DIDs only.
 */
import { getRepo, type YjsStore } from '../store/repo'
import {
  createRecipe as storeCreateRecipe,
  createRecipesAtomic,
  deleteRecipe as storeDeleteRecipe,
  getOrCreateIndex,
  getRecipe as storeGetRecipe,
  listRecipes as storeListRecipes,
  updateRecipe as storeUpdateRecipe,
  type KeyValueStore,
} from '../store/recipes'
import { getOrCreateIdentity } from '../identity/identity'
import { listFriends } from '../friends/friends'
import { friendlyError } from '../friendlyError'
import type { Recipe, RecipeInput, VisibilityTier } from '../types'

/** An error carrying the HTTP status the router should answer with. */
export class LocalApiError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.name = 'LocalApiError'
    this.status = status
  }
}

export interface ApiRecipeSummary {
  id: string
  title: string
  visibility: VisibilityTier
  updatedAt: string
}

export interface ApiRecipe extends ApiRecipeSummary {
  ingredients: string[]
  steps: string[]
  prepMinutes?: number
  cookMinutes?: number
  photos: string[]
  createdAt: string
}

export interface LocalApiHost {
  getIdentityDid(): Promise<string | null>
  listRecipes(): Promise<ApiRecipeSummary[]>
  /** Full recipe by id, or null when the id is unknown. */
  getRecipe(id: string): Promise<ApiRecipe | null>
  createRecipe(input: RecipeInput): Promise<{ id: string }>
  /** Full content update (router has already validated the shape). */
  updateRecipe(id: string, input: RecipeInput): Promise<void>
  /**
   * Delete with the UI's side paths. Returns the flow's warnings (H13:
   * remote copies that could not be taken down, the tombstone recall
   * limit) — the router includes them in the 200 body.
   */
  deleteRecipe(id: string): Promise<{ warnings: string[] }>
  /** Whether public publishing can run right now (signed-in session). */
  canPublish(): boolean
  /**
   * Move a recipe between the 'private' and 'public' tiers through the
   * app's byte-path flow. 'friends-only' is deliberately NOT offered:
   * it needs a person picking which friends, in the app. Returns the
   * flow's warnings (H13), as for deleteRecipe.
   */
  setVisibility(id: string, tier: 'private' | 'public'): Promise<{ warnings: string[] }>
  importRecipes(inputs: RecipeInput[]): Promise<string[]>
  /** Names + DIDs only — never pair secrets or shelf internals. */
  listFriends(): { name: string; did: string }[]
}

export interface LocalApiHostHooks {
  /** Content update with the UI's side paths (friends/PDS republish).
   *  Defaults to the bare store update. */
  applyUpdate?: (id: string, input: RecipeInput) => Promise<void>
  /**
   * Delete with the UI's side paths (unshare + unpublish first).
   * Defaults to the bare store delete. Returns the flow's warnings
   * (H13) — the router surfaces them to the caller.
   */
  applyDelete?: (id: string) => Promise<string[]>
  /**
   * The UI's visibility byte-path flow. Without it, tier changes are
   * rejected with a plain error. Returns the flow's warnings (H13).
   */
  applyVisibility?: (
    id: string,
    recipe: Recipe,
    tier: 'private' | 'public',
  ) => Promise<string[]>
  /** Whether a publishing session exists (App passes its session check). */
  canPublish?: () => boolean
  getIdentityDid?: () => Promise<string | null>
  /** Called after any mutation, so the UI can refresh itself. */
  onChanged?: () => void
  /** Test seams (production uses the app singletons). */
  repo?: YjsStore
  kv?: KeyValueStore
}

function toApiRecipe(id: string, recipe: Recipe): ApiRecipe {
  return {
    id,
    title: recipe.title,
    ingredients: recipe.ingredients,
    steps: recipe.steps,
    ...(recipe.prepMinutes !== undefined
      ? { prepMinutes: recipe.prepMinutes }
      : {}),
    ...(recipe.cookMinutes !== undefined
      ? { cookMinutes: recipe.cookMinutes }
      : {}),
    photos: recipe.photos,
    visibility: recipe.visibility ?? 'private',
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  }
}

/**
 * Build the host over the real store. With no hooks this is the plain
 * store surface (what unit tests use); App passes its UI flows as hooks
 * so API writes take exactly the UI's paths.
 */
export function createLocalApiHost(hooks: LocalApiHostHooks = {}): LocalApiHost {
  const repo = () => hooks.repo ?? getRepo()
  const index = () => getOrCreateIndex(repo(), hooks.kv)

  const host: LocalApiHost = {
    async getIdentityDid() {
      if (hooks.getIdentityDid) return hooks.getIdentityDid()
      const identity = await getOrCreateIdentity(hooks.kv)
      return identity.did
    },

    async listRecipes() {
      const idx = await index()
      const summaries = await storeListRecipes(idx)
      // Int L10 part (b): the tier rides in the index entry now, so
      // listing is ONE index read — the old loop loaded every full
      // recipe doc (photos included) just to learn its visibility.
      return summaries.map((s) => ({
        id: s.id,
        title: s.title,
        visibility: s.visibility ?? 'private',
        updatedAt: s.updatedAt,
      }))
    },

    async getRecipe(id) {
      const idx = await index()
      const entry = (await idx.doc())?.recipes[id]
      if (!entry) return null
      const recipe = await storeGetRecipe(repo(), entry.url)
      return recipe ? toApiRecipe(id, recipe) : null
    },

    async createRecipe(input) {
      const idx = await index()
      const summary = await storeCreateRecipe(repo(), idx, input)
      hooks.onChanged?.()
      return { id: summary.id }
    },

    async updateRecipe(id, input) {
      if (hooks.applyUpdate) {
        await hooks.applyUpdate(id, input)
      } else {
        const idx = await index()
        await storeUpdateRecipe(repo(), idx, id, {
          title: input.title,
          ingredients: input.ingredients,
          steps: input.steps,
          photos: input.photos,
          prepMinutes: input.prepMinutes,
          cookMinutes: input.cookMinutes,
        })
      }
      hooks.onChanged?.()
    },

    async deleteRecipe(id) {
      let warnings: string[] = []
      if (hooks.applyDelete) {
        warnings = await hooks.applyDelete(id)
      } else {
        const idx = await index()
        await storeDeleteRecipe(repo(), idx, id)
      }
      hooks.onChanged?.()
      return { warnings }
    },

    canPublish() {
      return hooks.canPublish ? hooks.canPublish() : false
    },

    async setVisibility(id, tier) {
      if (!hooks.applyVisibility) {
        throw new LocalApiError(
          422,
          'Visibility can only be changed in the Longtable app right now.',
        )
      }
      const idx = await index()
      const entry = (await idx.doc())?.recipes[id]
      const recipe = entry ? await storeGetRecipe(repo(), entry.url) : null
      if (!recipe) {
        throw new LocalApiError(404, 'No recipe with that id exists in this cookbook.')
      }
      try {
        const warnings = await hooks.applyVisibility(id, recipe, tier)
        hooks.onChanged?.()
        return { warnings }
      } catch (e) {
        if (e instanceof LocalApiError) throw e
        throw new LocalApiError(502, friendlyError(e, 'the publishing server'))
      }
    },

    async importRecipes(inputs) {
      const idx = await index()
      // H11: atomic, best-effort — a mid-loop store failure rolls back
      // what was already created and says so, instead of leaving a
      // partial import behind a "nothing was changed" 500.
      let ids: string[]
      try {
        ids = await createRecipesAtomic(repo(), idx, inputs)
      } catch (e) {
        throw new LocalApiError(
          500,
          e instanceof Error ? e.message : 'The import failed and nothing was imported.',
        )
      }
      hooks.onChanged?.()
      return ids
    },

    listFriends() {
      // Strip everything but name + DID: pair secrets, pair ids and
      // channel details never leave through the API.
      return listFriends(hooks.kv).map((f) => ({ name: f.name, did: f.did }))
    },
  }
  return host
}
