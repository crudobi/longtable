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
  deleteRecipe(id: string): Promise<void>
  /** Whether public publishing can run right now (signed-in session). */
  canPublish(): boolean
  /**
   * Move a recipe between the 'private' and 'public' tiers through the
   * app's byte-path flow. 'friends-only' is deliberately NOT offered:
   * it needs a person picking which friends, in the app.
   */
  setVisibility(id: string, tier: 'private' | 'public'): Promise<void>
  importRecipes(inputs: RecipeInput[]): Promise<string[]>
  /** Names + DIDs only — never pair secrets or shelf internals. */
  listFriends(): { name: string; did: string }[]
}

export interface LocalApiHostHooks {
  /** Content update with the UI's side paths (friends/PDS republish).
   *  Defaults to the bare store update. */
  applyUpdate?: (id: string, input: RecipeInput) => Promise<void>
  /** Delete with the UI's side paths (unshare + unpublish first).
   *  Defaults to the bare store delete. */
  applyDelete?: (id: string) => Promise<void>
  /** The UI's visibility byte-path flow. Without it, tier changes are
   *  rejected with a plain error. */
  applyVisibility?: (
    id: string,
    recipe: Recipe,
    tier: 'private' | 'public',
  ) => Promise<void>
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
      const out: ApiRecipeSummary[] = []
      for (const s of summaries) {
        const full = await host.getRecipe(s.id)
        out.push({
          id: s.id,
          title: s.title,
          visibility: full?.visibility ?? 'private',
          updatedAt: s.updatedAt,
        })
      }
      return out
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
      if (hooks.applyDelete) {
        await hooks.applyDelete(id)
      } else {
        const idx = await index()
        await storeDeleteRecipe(repo(), idx, id)
      }
      hooks.onChanged?.()
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
        await hooks.applyVisibility(id, recipe, tier)
      } catch (e) {
        if (e instanceof LocalApiError) throw e
        throw new LocalApiError(502, friendlyError(e, 'the publishing server'))
      }
      hooks.onChanged?.()
    },

    async importRecipes(inputs) {
      const idx = await index()
      const ids: string[] = []
      for (const input of inputs) {
        const summary = await storeCreateRecipe(repo(), idx, input)
        ids.push(summary.id)
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
