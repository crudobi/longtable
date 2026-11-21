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
 *    The token is compared in constant time (Sec L7): a plain `!==`
 *    leaks the first differing byte position through timing. Health
 *    stays unauthenticated by design — it only says the API is up —
 *    and the loopback-only bind is the boundary: on Android any local
 *    app can reach loopback (including via an adb forward), so the
 *    token, not the network, is the access control (accepted residual,
 *    see docs/localhost-api.md).
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
 *  - Destructive calls need an explicit human gate (H12): DELETE, and
 *    any create/update that makes a recipe public, require
 *    `"confirm": true` in the JSON body — the API's equivalent of the
 *    UI's delete / make-public confirm dialogs. The token authorizes
 *    the caller; the confirm proves the caller meant this irreversible
 *    act. Without it the call is refused with 422 and nothing is
 *    written.
 *  - Warnings ride in 200/201 bodies (H13): `warnings: string[]` —
 *    remote copies that could not be taken down, the tombstone recall
 *    limit on a delete, import notes (dropped photos). A warning never
 *    means the call failed; it means something about the result needs
 *    the caller's attention. Always present (possibly empty) on
 *    DELETE, PUT, public POST, and POST /v1/import.
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

/**
 * Constant-time string equality (Sec L7). Compares every byte of both
 * strings and folds the length difference into the result, so the
 * runtime does not depend on where (or whether) the strings differ —
 * a plain `!==` returns on the first differing byte and leaks its
 * position through timing. This is a JS-level mitigation, not a
 * cryptographic guarantee: JIT and GC jitter dominate at this scale,
 * but the early-exit signal is gone. Exported for unit tests.
 */
export function constantTimeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length)
  let diff = a.length ^ b.length
  for (let i = 0; i < len; i++) {
    const ac = i < a.length ? a.charCodeAt(i) : 0
    const bc = i < b.length ? b.charCodeAt(i) : 0
    diff |= ac ^ bc
  }
  return diff === 0
}

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
  /** Explicit human gate for destructive acts (H12) — see requireConfirm. */
  confirm?: boolean
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
  let confirm: boolean | undefined
  if ('confirm' in r && r.confirm !== undefined) {
    if (typeof r.confirm !== 'boolean') {
      throw new LocalApiError(400, '"confirm" must be true or false.')
    }
    confirm = r.confirm
  }
  // ImporterError (→ 422) on any shape problem; the message is plain.
  const input = validateImportedRecipe(r, 'localhost API')
  return { input, visibility, confirm }
}

/**
 * The confirm gate (H12): destructive calls need `"confirm": true` in
 * the body — the API's equivalent of the UI's confirm dialog. Refused
 * with 422 before anything is written, with the consequence in the
 * message so a script author knows what they are confirming.
 */
function requireConfirm(confirmed: boolean | undefined, what: string): void {
  if (confirmed === true) return
  throw new LocalApiError(422, `${what} Send "confirm": true in the request body to confirm.`)
}

/**
 * Read an optional JSON body for calls that take no other body (DELETE):
 * absent body → undefined (no confirm); present but malformed → 400;
 * present and an object → its `confirm` field (must be boolean).
 */
function parseOptionalConfirm(req: ApiRequest): boolean | undefined {
  if (!req.body || !req.body.trim()) return undefined
  let raw: unknown
  try {
    raw = JSON.parse(req.body) as unknown
  } catch {
    throw new LocalApiError(400, 'That request body was not valid JSON.')
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LocalApiError(400, 'Expected a JSON object with "confirm".')
  }
  const confirm = (raw as Record<string, unknown>).confirm
  if (confirm !== undefined && typeof confirm !== 'boolean') {
    throw new LocalApiError(400, '"confirm" must be true or false.')
  }
  return confirm
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
  // Constant-time compare (Sec L7) — see constantTimeEqual.
  if (!settings.token || !constantTimeEqual(auth ?? '', `Bearer ${settings.token}`)) {
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
    const { input, visibility, confirm } = parseRecipeBody(req)
    checkTierAllowed(visibility)
    if (visibility === 'public') {
      // H12: making a recipe public is the one wide-exposure move — the
      // UI confirms it first, and so must the API, before anything is
      // written. (The sign-in refusal below is a separate 422.)
      requireConfirm(
        confirm,
        'Making a recipe public lists it under your publishing account for anyone to find.',
      )
    }
    if (visibility === 'public' && !host.canPublish()) {
      // Refuse BEFORE creating anything, so a refused publish never
      // leaves a surprise private recipe behind.
      throw new LocalApiError(422, NOT_SIGNED_IN)
    }
    const { id } = await host.createRecipe(input)
    let warnings: string[] = []
    if (visibility === 'public') {
      ;({ warnings } = await host.setVisibility(id, 'public'))
    }
    return ok(201, { id, title: input.title, visibility: visibility ?? 'private', warnings })
  }

  if (method === 'PUT' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    const { input, visibility, confirm } = parseRecipeBody(req)
    checkTierAllowed(visibility)
    const target = visibility as 'private' | 'public' | undefined
    let warnings: string[] = []
    if (target && target !== existing.visibility) {
      if (target === 'public') {
        // H12: see the POST branch — the confirm comes first, before
        // the sign-in check and before anything is written.
        requireConfirm(
          confirm,
          'Making a recipe public lists it under your publishing account for anyone to find.',
        )
        if (!host.canPublish()) throw new LocalApiError(422, NOT_SIGNED_IN)
        // Update content while still private (a plain update — no
        // republish of half-moved state), then publish the new content
        // through the byte-path flow in one write.
        await host.updateRecipe(id, input)
        ;({ warnings } = await host.setVisibility(id, 'public'))
      } else {
        // Going private: unpublish through the flow FIRST, then update
        // as an ordinary private recipe.
        ;({ warnings } = await host.setVisibility(id, 'private'))
        await host.updateRecipe(id, input)
      }
    } else {
      await host.updateRecipe(id, input)
    }
    return ok(200, { id, visibility: target ?? existing.visibility, warnings })
  }

  if (method === 'DELETE' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    // H12: deleting is permanent — the UI confirms first, and so must
    // the API. Refused before the flow runs, so nothing is unwritten.
    requireConfirm(
      parseOptionalConfirm(req),
      'Deleting a recipe is permanent — it cannot be undone.',
    )
    const { warnings } = await host.deleteRecipe(id)
    return ok(200, { id, deleted: true, warnings })
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
    const { recipes, warnings } = await runImporter(r.importerId, {
      kind: 'text',
      text: r.text,
    })
    const ids = await host.importRecipes(recipes)
    return ok(201, { importer: r.importerId, imported: ids, count: ids.length, warnings })
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
      'Something went wrong on the device while handling that request. ' +
        'Some changes may already have been applied — check the recipe ' +
        'list before trying again.',
    )
  }
}
