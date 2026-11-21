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
import { getPublication } from '../public/publish'
import type {
  Recipe,
  RecipeInput,
  RecipePatch,
  SourceTimestamps,
  VisibilityTier,
} from '../types'

/** An error carrying the HTTP status the router should answer with. */
export class LocalApiError extends Error {
  readonly status: number
  /** Structured extra body fields (M23: a failed visibility flip
   *  reports what actually changed under `changed`). */
  readonly details?: Record<string, unknown>
  constructor(
    status: number,
    message: string,
    details?: Record<string, unknown>,
  ) {
    super(message)
    this.name = 'LocalApiError'
    this.status = status
    this.details = details
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
  description?: string
  recipeYield?: string
  tags?: string[]
  author?: string
  sourceUrl?: string
  createdAt: string
}

/** Whether a public record is recorded for a recipe (M23). */
export type PublicRecordState = 'listed' | 'not listed' | 'unknown'

/** What a visibility move returns: the flow's warnings (H13) plus
 *  whether a public record is recorded afterwards (M23), so the
 *  router can say what a part-way flip actually left behind. */
export interface VisibilityChange {
  warnings: string[]
  publicRecord: PublicRecordState
}

export interface LocalApiHost {
  getIdentityDid(): Promise<string | null>
  listRecipes(): Promise<ApiRecipeSummary[]>
  /** Full recipe by id, or null when the id is unknown. */
  getRecipe(id: string): Promise<ApiRecipe | null>
  /** Create, optionally with the source's own timestamps (M24: a
   *  backup restore keeps its original created/updated times). */
  createRecipe(
    input: RecipeInput,
    timestamps?: SourceTimestamps,
  ): Promise<{ id: string }>
  /** Full content update (router has already validated the shape). */
  updateRecipe(id: string, input: RecipeInput): Promise<void>
  /**
   * Partial content update (M22: PATCH). Only the fields present in
   * `patch` change; an explicit `undefined` clears an optional field.
   * Visibility is never applied here — the router runs the tier flow
   * (setVisibility) for it. Runs the UI's update flow when one is
   * wired (friends / public republish), else the bare store update.
   */
  patchRecipe(id: string, patch: RecipePatch): Promise<void>
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
   * flow's warnings (H13), as for deleteRecipe, plus whether a public
   * record is recorded afterwards (M23). On failure throws a 502
   * whose `details.changed` reports the recipe as it actually stands
   * now — a flip that fails part-way must not hide what moved.
   */
  setVisibility(
    id: string,
    tier: 'private' | 'public',
  ): Promise<VisibilityChange>
  /** Create the validated recipes, optionally with per-recipe source
   *  timestamps (M24), parallel to `inputs`. */
  importRecipes(
    inputs: RecipeInput[],
    timestamps?: (SourceTimestamps | undefined)[],
  ): Promise<string[]>
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
    // Descriptive fields the store keeps (M24 / M22): the API used to
    // drop them on read, so a PATCH to one was unobservable over the
    // wire. They ride through when set, like the edit form's fields.
    ...(recipe.description !== undefined
      ? { description: recipe.description }
      : {}),
    ...(recipe.recipeYield !== undefined
      ? { recipeYield: recipe.recipeYield }
      : {}),
    ...(recipe.tags !== undefined ? { tags: recipe.tags } : {}),
    ...(recipe.author !== undefined ? { author: recipe.author } : {}),
    ...(recipe.sourceUrl !== undefined ? { sourceUrl: recipe.sourceUrl } : {}),
    visibility: recipe.visibility ?? 'private',
    createdAt: recipe.createdAt,
    updatedAt: recipe.updatedAt,
  }
}

/**
 * Whether a public record is recorded for this recipe (M23): read
 * from the publications registry. 'unknown' when the registry cannot
 * be read here (no localStorage in this environment).
 */
function readPublicRecord(id: string): PublicRecordState {
  try {
    return getPublication(id) ? 'listed' : 'not listed'
  } catch {
    return 'unknown'
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

    async createRecipe(input, timestamps) {
      const idx = await index()
      // M24: a lone updatedAt stands in for createdAt, so a source
      // that only kept one time still restores coherently.
      const stamp =
        timestamps?.createdAt !== undefined ||
        timestamps?.updatedAt !== undefined
          ? {
              createdAt: timestamps.createdAt ?? timestamps.updatedAt,
              updatedAt: timestamps.updatedAt ?? timestamps.createdAt,
            }
          : undefined
      const summary = await storeCreateRecipe(repo(), idx, input, stamp)
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

    async patchRecipe(id, patch) {
      // Visibility is never applied here: the router runs the tier
      // flow (setVisibility) for it, so a patch can never mark a tier
      // directly without the byte-path flow.
      const contentPatch: RecipePatch = { ...patch }
      delete contentPatch.visibility
      if (hooks.applyUpdate) {
        // The UI's update flow takes a full input, so merge the patch
        // over the stored recipe first — the flow then republishes to
        // friends / the PDS exactly as an in-app edit would. Fields
        // the patch does not mention keep their stored values; an
        // explicit `undefined` in the patch clears the field (the
        // merged object carries the key, so the flow's `'field' in
        // input` checks see the clear).
        const existing = await host.getRecipe(id)
        if (!existing) {
          throw new LocalApiError(
            404,
            'No recipe with that id exists in this cookbook.',
          )
        }
        const merged: RecipeInput = {
          title: existing.title,
          ingredients: existing.ingredients,
          steps: existing.steps,
          photos: existing.photos,
          ...(existing.prepMinutes !== undefined
            ? { prepMinutes: existing.prepMinutes }
            : {}),
          ...(existing.cookMinutes !== undefined
            ? { cookMinutes: existing.cookMinutes }
            : {}),
        }
        for (const [key, value] of Object.entries(contentPatch)) {
          // Assign even when undefined: the key's presence is the
          // "clear this field" signal for the UI flow's `in` checks.
          ;(merged as Record<string, unknown>)[key] = value
        }
        await hooks.applyUpdate(id, merged)
      } else {
        const idx = await index()
        await storeUpdateRecipe(repo(), idx, id, contentPatch)
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
        return { warnings, publicRecord: readPublicRecord(id) }
      } catch (e) {
        if (e instanceof LocalApiError) throw e
        // M23: the flip may have moved some bytes before failing — a
        // publish can land while the local tier-mark fails, or an
        // unpublish can land while the tier-mark fails. Report the
        // state the recipe is actually in now (tier, updatedAt, and
        // whether a public record is recorded for it) instead of a
        // bare error: the caller can then retry the same call
        // idempotently, or clean up the side that moved. The cause
        // stays in the device log.
        console.warn('[longtable] localhost API visibility flip failed part-way', e)
        const current = await host.getRecipe(id).catch(() => null)
        const publicRecord = readPublicRecord(id)
        const changed = current
          ? {
              id,
              visibility: current.visibility,
              updatedAt: current.updatedAt,
              publicRecord,
            }
          : undefined
        const state = current
          ? ` The recipe is still ${current.visibility} on this device` +
            (publicRecord === 'listed'
              ? ' and the public copy is still listed.'
              : publicRecord === 'not listed'
                ? ' and no public copy is recorded for it.'
                : '.')
          : ''
        const reason = friendlyError(e, 'the publishing server')
        const reasonSentence = reason.endsWith('.') ? reason : `${reason}.`
        throw new LocalApiError(
          502,
          `${reasonSentence}${state}`,
          changed ? { changed } : undefined,
        )
      }
    },

    async importRecipes(inputs, timestamps) {
      const idx = await index()
      // H11: atomic, best-effort — a mid-loop store failure rolls back
      // what was already created and says so, instead of leaving a
      // partial import behind a "nothing was changed" 500.
      let ids: string[]
      try {
        ids = await createRecipesAtomic(repo(), idx, inputs, timestamps)
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
