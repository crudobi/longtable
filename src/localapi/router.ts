/**
 * Localhost API v1 router — the whole HTTP surface in one pure function.
 *
 * `handleApiRequest` takes a plain request object and the host seam, and
 * returns a plain response object; the native plugin bridge (server.ts)
 * is the only transport code. That split is what lets the unit tests
 * exercise every route, status code, and auth rule without a socket.
 *
 * Rules baked in here:
 *  - GET /v1/health is the ONLY unauthenticated route. Everything else
 *    needs `Authorization: Bearer <token>` from the API settings.
 *  - Errors are `{ error: "<plain-language message>" }` with a correct
 *    status code. Stack traces and raw transport errors never surface.
 *  - Recipe writes validate with the Importer API's validator
 *    (`validateImportedRecipe`) — the API accepts exactly the shape an
 *    importer may produce, nothing more.
 *  - Visibility: 'private' is the default. 'public' goes through the
 *    host's byte-path flow (and is refused up front when no publishing
 *    session exists, before anything is written). 'friends-only' is
 *    refused with a plain explanation — choosing friends is an in-app
 *    act, and faking the tier without the encrypted shares would lie.
 */
import { ImporterError, validateImportedRecipe } from '../importers/contract'
import { ensurePluginsLoaded, runImporter } from '../importers/registry'
import type { RecipeInput } from '../types'
import { LocalApiError, type LocalApiHost } from './host'
import { LOCAL_API_VERSION, type LocalApiSettings } from './settings'

export interface ApiRequest {
  method: string
  /** Path only (no query string), e.g. "/v1/recipes/<id>". */
  path: string
  /** Raw query string without the leading '?'. */
  query?: string
  headers: Record<string, string>
  /** Raw body text ('' when there is none). */
  body?: string
}

export interface ApiResponse {
  status: number
  body: unknown
}

const ok = (status: number, body: unknown): ApiResponse => ({ status, body })
const fail = (status: number, message: string): ApiResponse => ({
  status,
  body: { error: message },
})

function headerValue(
  headers: Record<string, string>,
  name: string,
): string | undefined {
  const lower = name.toLowerCase()
  for (const [k, v] of Object.entries(headers)) {
    if (k.toLowerCase() === lower) return v
  }
  return undefined
}

function parseJsonBody(req: ApiRequest): unknown {
  if (!req.body || !req.body.trim()) {
    throw new LocalApiError(400, 'That request had no JSON body.')
  }
  try {
    return JSON.parse(req.body) as unknown
  } catch {
    throw new LocalApiError(400, 'That request body was not valid JSON.')
  }
}

interface RecipeBody {
  input: RecipeInput
  visibility?: string
}

/** Validate a create/update body: importer recipe shape + optional tier. */
function parseRecipeBody(req: ApiRequest): RecipeBody {
  const raw = parseJsonBody(req)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LocalApiError(400, 'Expected a JSON object describing the recipe.')
  }
  const r = raw as Record<string, unknown>
  let visibility: string | undefined
  if ('visibility' in r && r.visibility !== undefined) {
    if (typeof r.visibility !== 'string') {
      throw new LocalApiError(
        400,
        '"visibility" must be "private", "friends-only", or "public".',
      )
    }
    visibility = r.visibility
  }
  // ImporterError (→ 422) on any shape problem; the message is plain.
  const input = validateImportedRecipe(r, 'localhost API')
  return { input, visibility }
}

/**
 * Refuse tiers the API cannot honor honestly, before anything is
 * written. Returns the tier narrowed to what may proceed.
 */
function checkTierAllowed(visibility: string | undefined): void {
  if (
    visibility === undefined ||
    visibility === 'private' ||
    visibility === 'public'
  ) {
    return
  }
  if (visibility === 'friends-only') {
    throw new LocalApiError(
      422,
      'Friends-only sharing is chosen in the Longtable app, so you pick ' +
        'which friends see the recipe. Save it as private here, then ' +
        'share it from the app.',
    )
  }
  throw new LocalApiError(
    400,
    `"visibility" must be "private", "friends-only", or "public" — got "${visibility}".`,
  )
}

const NOT_SIGNED_IN =
  'That recipe can\'t be made public yet: no publishing account is ' +
  'signed in on this device. Sign in under Publishing in the app, or ' +
  'save the recipe as private.'

async function route(
  req: ApiRequest,
  host: LocalApiHost | null,
  settings: LocalApiSettings,
): Promise<ApiResponse> {
  const method = req.method.toUpperCase()
  const path = req.path.length > 1 ? req.path.replace(/\/+$/, '') : req.path
  const seg = path.split('/').filter(Boolean)

  // The one open route — used by scripts to find the API at all.
  if (method === 'GET' && path === '/v1/health') {
    return ok(200, { ok: true, version: LOCAL_API_VERSION, app: 'longtable' })
  }

  // Everything else is authenticated. The token lives in the API
  // settings; it is compared in full, as an Authorization bearer value.
  const auth = headerValue(req.headers, 'authorization')
  if (!settings.token || auth !== `Bearer ${settings.token}`) {
    return fail(
      401,
      'Missing or wrong API token. Send the token shown in Longtable ' +
        'under Developer → Localhost API as "Authorization: Bearer <token>".',
    )
  }

  if (!host) {
    return fail(503, 'Longtable is still starting up — try again in a moment.')
  }

  const isRecipes = seg[0] === 'v1' && seg[1] === 'recipes'

  if (method === 'GET' && path === '/v1/identity') {
    const did = await host.getIdentityDid()
    if (!did) return fail(503, 'This device has no identity yet.')
    return ok(200, { did })
  }

  if (method === 'GET' && path === '/v1/friends') {
    return ok(200, { friends: host.listFriends() })
  }

  if (method === 'GET' && isRecipes && seg.length === 2) {
    const summaries = await host.listRecipes()
    const q = (new URLSearchParams(req.query ?? '').get('q') ?? '')
      .trim()
      .toLowerCase()
    if (!q) return ok(200, { recipes: summaries })
    const matches: typeof summaries = []
    for (const s of summaries) {
      if (s.title.toLowerCase().includes(q)) {
        matches.push(s)
        continue
      }
      const full = await host.getRecipe(s.id)
      if (full && full.ingredients.some((i) => i.toLowerCase().includes(q))) {
        matches.push(s)
      }
    }
    return ok(200, { recipes: matches })
  }

  if (method === 'GET' && isRecipes && seg.length === 3) {
    const recipe = await host.getRecipe(seg[2])
    if (!recipe) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    return ok(200, recipe)
  }

  if (method === 'POST' && isRecipes && seg.length === 2) {
    const { input, visibility } = parseRecipeBody(req)
    checkTierAllowed(visibility)
    if (visibility === 'public' && !host.canPublish()) {
      // Refuse BEFORE creating anything, so a refused publish never
      // leaves a surprise private recipe behind.
      throw new LocalApiError(422, NOT_SIGNED_IN)
    }
    const { id } = await host.createRecipe(input)
    if (visibility === 'public') {
      await host.setVisibility(id, 'public')
    }
    return ok(201, { id, title: input.title, visibility: visibility ?? 'private' })
  }

  if (method === 'PUT' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    const { input, visibility } = parseRecipeBody(req)
    checkTierAllowed(visibility)
    const target = visibility as 'private' | 'public' | undefined
    if (target && target !== existing.visibility) {
      if (target === 'public') {
        if (!host.canPublish()) throw new LocalApiError(422, NOT_SIGNED_IN)
        // Update content while still private (a plain update — no
        // republish of half-moved state), then publish the new content
        // through the byte-path flow in one write.
        await host.updateRecipe(id, input)
        await host.setVisibility(id, 'public')
      } else {
        // Going private: unpublish through the flow FIRST, then update
        // as an ordinary private recipe.
        await host.setVisibility(id, 'private')
        await host.updateRecipe(id, input)
      }
    } else {
      await host.updateRecipe(id, input)
    }
    return ok(200, { id, visibility: target ?? existing.visibility })
  }

  if (method === 'DELETE' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    await host.deleteRecipe(id)
    return ok(200, { id, deleted: true })
  }

  if (method === 'POST' && path === '/v1/import') {
    const raw = parseJsonBody(req)
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
      throw new LocalApiError(400, 'Expected a JSON object with "importerId" and "text".')
    }
    const r = raw as Record<string, unknown>
    if (typeof r.importerId !== 'string' || !r.importerId) {
      throw new LocalApiError(400, '"importerId" is required — the id of a registered importer.')
    }
    if (typeof r.text !== 'string') {
      throw new LocalApiError(400, '"text" is required — the source text for the importer.')
    }
    await ensurePluginsLoaded()
    // runImporter validates every recipe; one bad recipe fails the
    // whole import and nothing is saved (same atomicity as the UI).
    const { recipes } = await runImporter(r.importerId, {
      kind: 'text',
      text: r.text,
    })
    const ids = await host.importRecipes(recipes)
    return ok(201, { importer: r.importerId, imported: ids, count: ids.length })
  }

  if (seg[0] === 'v1' && (seg[1] === 'recipes' || seg[1] === 'import' || seg[1] === 'identity' || seg[1] === 'friends' || seg[1] === 'health')) {
    return fail(405, `Method ${method} is not supported for ${path}.`)
  }
  return fail(404, 'No such endpoint in API v1. See docs/localhost-api.md.')
}

/**
 * The router entry point: never throws. Every failure becomes a
 * `{ error }` body with the right status — LocalApiError carries its
 * own, importer validation failures are 422, and anything unexpected is
 * a plain 500 (details stay in the device log, never on the wire).
 */
export async function handleApiRequest(
  req: ApiRequest,
  host: LocalApiHost | null,
  settings: LocalApiSettings,
): Promise<ApiResponse> {
  try {
    return await route(req, host, settings)
  } catch (e) {
    if (e instanceof LocalApiError) return fail(e.status, e.message)
    if (e instanceof ImporterError) return fail(422, e.message)
    console.warn('[longtable] localhost API request failed', e)
    return fail(
      500,
      "Something went wrong on the device while handling that request. " +
        'Nothing was changed — try again.',
    )
  }
}
