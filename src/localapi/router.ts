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
 *    DELETE, PUT, PATCH, public POST, and POST /v1/import.
 *  - PATCH (M22) is the partial update: only the fields sent change,
 *    and an optional `expectedUpdatedAt` in the body is a lost-update
 *    precondition — a stale value is refused with 412 and nothing is
 *    written. PUT accepts the same precondition.
 *  - A visibility flip that fails part-way (M23) answers 502 with a
 *    `changed` block — the recipe's tier, updatedAt, and whether a
 *    public record is recorded for it, as they actually stand now —
 *    instead of a bare error that hides what moved.
 *  - POST /v1/import (M24) takes a page `url` for the URL importer as
 *    well as `text`, and source timestamps ride through an import so
 *    a backup restores with its original times.
 */
import {
  ImporterError,
  isValidIsoTimestamp,
  validateImportedRecipe,
  validateRecipePatch,
} from '../importers/contract'
import { ensurePluginsLoaded, runImporter } from '../importers/registry'
import type { RecipeInput, RecipePatch } from '../types'
import {
  LocalApiError,
  type ApiRecipe,
  type LocalApiHost,
  type PublicRecordState,
} from './host'
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
const fail = (
  status: number,
  message: string,
  details?: Record<string, unknown>,
): ApiResponse => ({
  status,
  body: { error: message, ...(details ?? {}) },
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
  /** Explicit human gate for destructive acts (H12) — see requireConfirm. */
  confirm?: boolean
  /** Optional source timestamps (M24) — the recipe keeps its original times. */
  createdAt?: string
  updatedAt?: string
  /** Optional lost-update precondition (M22) — the `updatedAt` last read. */
  expectedUpdatedAt?: string
}

/** Read an optional `visibility` field: must be a string when present. */
function parseVisibilityField(r: Record<string, unknown>): string | undefined {
  if (!('visibility' in r) || r.visibility === undefined) return undefined
  if (typeof r.visibility !== 'string') {
    throw new LocalApiError(
      400,
      '"visibility" must be "private", "friends-only", or "public".',
    )
  }
  return r.visibility
}

/** Read an optional `confirm` field: must be a boolean when present. */
function parseConfirmField(r: Record<string, unknown>): boolean | undefined {
  if (!('confirm' in r) || r.confirm === undefined) return undefined
  if (typeof r.confirm !== 'boolean') {
    throw new LocalApiError(400, '"confirm" must be true or false.')
  }
  return r.confirm
}

/**
 * Read an optional `expectedUpdatedAt` field (M22): the `updatedAt`
 * the caller read, for the lost-update precondition. Must be a
 * parseable ISO-8601 date when present.
 */
function parseExpectedUpdatedAtField(
  r: Record<string, unknown>,
): string | undefined {
  if (!('expectedUpdatedAt' in r) || r.expectedUpdatedAt === undefined) {
    return undefined
  }
  if (!isValidIsoTimestamp(r.expectedUpdatedAt)) {
    throw new LocalApiError(
      400,
      '"expectedUpdatedAt" must be an ISO-8601 date string, e.g. the "updatedAt" from a GET.',
    )
  }
  return r.expectedUpdatedAt
}

/**
 * Read optional source timestamps (M24): `createdAt`/`updatedAt` the
 * caller is restoring. Must be parseable ISO-8601 dates when present.
 */
function parseSourceTimestamps(r: Record<string, unknown>): {
  createdAt?: string
  updatedAt?: string
} {
  const out: { createdAt?: string; updatedAt?: string } = {}
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (field in r && r[field] !== undefined) {
      if (!isValidIsoTimestamp(r[field])) {
        throw new LocalApiError(
          400,
          `"${field}" must be an ISO-8601 date string.`,
        )
      }
      out[field] = r[field] as string
    }
  }
  return out
}

/** Validate a create/update body: importer recipe shape + optional tier. */
function parseRecipeBody(req: ApiRequest): RecipeBody {
  const raw = parseJsonBody(req)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LocalApiError(400, 'Expected a JSON object describing the recipe.')
  }
  const r = raw as Record<string, unknown>
  const visibility = parseVisibilityField(r)
  const confirm = parseConfirmField(r)
  const expectedUpdatedAt = parseExpectedUpdatedAtField(r)
  const { createdAt, updatedAt } = parseSourceTimestamps(r)
  // ImporterError (→ 422) on any shape problem; the message is plain.
  const input = validateImportedRecipe(r, 'localhost API')
  return { input, visibility, confirm, createdAt, updatedAt, expectedUpdatedAt }
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

/**
 * The lost-update guard (M22): when the caller sends the `updatedAt`
 * it read, refuse (412) when the stored recipe has moved since — the
 * caller's view is stale and its write would silently overwrite the
 * newer version. Checked after the body parses and before anything
 * is written, so a stale call never writes. Absent = no check (older
 * clients keep working, unguarded).
 */
function checkPrecondition(
  existing: { updatedAt: string },
  expectedUpdatedAt: string | undefined,
): void {
  if (expectedUpdatedAt === undefined) return
  if (expectedUpdatedAt !== existing.updatedAt) {
    throw new LocalApiError(
      412,
      `That recipe changed since you last read it (it was updated at ${existing.updatedAt}). Read it again and retry your change against the new version.`,
    )
  }
}

interface PatchBody {
  patch: RecipePatch
  visibility?: string
  confirm?: boolean
  expectedUpdatedAt?: string
}

/**
 * Validate a PATCH body (M22): the content fields go through the
 * importer's patch validator — partial, so absent fields are
 * untouched and `null` clears an optional field — while `visibility`
 * / `confirm` / `expectedUpdatedAt` are the call's own fields, not
 * recipe fields. An unknown field is rejected outright: a silently
 * ignored typo'd field in a patch is a lost update by another name.
 */
function parsePatchBody(req: ApiRequest): PatchBody {
  const raw = parseJsonBody(req)
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new LocalApiError(400, 'Expected a JSON object describing the change.')
  }
  const r = raw as Record<string, unknown>
  const visibility = parseVisibilityField(r)
  const confirm = parseConfirmField(r)
  const expectedUpdatedAt = parseExpectedUpdatedAtField(r)
  const rest: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(r)) {
    if (key === 'visibility' || key === 'confirm' || key === 'expectedUpdatedAt') {
      continue
    }
    rest[key] = value
  }
  const known = new Set([
    'title',
    'ingredients',
    'steps',
    'photos',
    'prepMinutes',
    'cookMinutes',
    'description',
    'recipeYield',
    'tags',
    'author',
    'sourceUrl',
  ])
  for (const key of Object.keys(rest)) {
    if (!known.has(key)) {
      throw new LocalApiError(400, `"${key}" is not a recipe field.`)
    }
  }
  // ImporterError (→ 422) on any shape problem; the message is plain.
  const patch = validateRecipePatch(rest, 'localhost API')
  if (Object.keys(patch).length === 0 && visibility === undefined) {
    throw new LocalApiError(
      400,
      'Nothing to change — send at least one recipe field or a new visibility.',
    )
  }
  return { patch, visibility, confirm, expectedUpdatedAt }
}

/**
 * One write plus an optional tier change, in the order that keeps a
 * partial failure honest (M23): going public writes the new content
 * while still private, then publishes it; going private unpublishes
 * first, then writes the new content. The confirm + sign-in refusals
 * (422) happen before anything is written. A failure inside the flip
 * itself already carries the host's `changed` report; the one failure
 * the host cannot see — the content write AFTER a successful flip —
 * is answered here as a 502 with the recipe as it now stands.
 */
async function applyWriteWithFlip(
  host: LocalApiHost,
  id: string,
  existing: ApiRecipe,
  target: 'private' | 'public' | undefined,
  confirm: boolean | undefined,
  write: () => Promise<void>,
): Promise<{ warnings: string[] }> {
  let warnings: string[] = []
  let publicRecord: PublicRecordState = 'unknown'
  try {
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
        await write()
        const flip = await host.setVisibility(id, 'public')
        warnings = flip.warnings
        publicRecord = flip.publicRecord
      } else {
        // Going private: unpublish through the flow FIRST, then update
        // as an ordinary private recipe.
        const flip = await host.setVisibility(id, 'private')
        warnings = flip.warnings
        publicRecord = flip.publicRecord
        await write()
      }
    } else {
      await write()
    }
  } catch (e) {
    if (e instanceof LocalApiError && e.details?.changed !== undefined) throw e
    if (target === 'private' && target !== existing.visibility) {
      const after = await host.getRecipe(id).catch(() => null)
      if (after && after.visibility === 'private') {
        // The flip landed, the content write after it did not: say
        // so plainly, with the recipe as it now stands. The cause
        // stays in the device log.
        console.warn('[longtable] localhost API flip landed but the content write failed', e)
        throw new LocalApiError(
          502,
          'The recipe is now private, but saving the new content failed. ' +
            'The recipe still has its previous content — read it again and retry the change.',
          {
            changed: {
              id,
              visibility: 'private',
              updatedAt: after.updatedAt,
              publicRecord,
            },
          },
        )
      }
    }
    throw e
  }
  return { warnings }
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
    const { input, visibility, confirm, createdAt, updatedAt } =
      parseRecipeBody(req)
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
    // M24: a create may carry the source's own timestamps (a backup
    // restore), so the recipe keeps its original times.
    const timestamps =
      createdAt !== undefined || updatedAt !== undefined
        ? { createdAt, updatedAt }
        : undefined
    const { id } = await host.createRecipe(input, timestamps)
    let warnings: string[] = []
    if (visibility === 'public') {
      ;({ warnings } = await host.setVisibility(id, 'public'))
    }
    // Echo the stored timestamps when the caller supplied source
    // ones, so a restore can confirm what actually landed.
    const stored = timestamps ? await host.getRecipe(id) : null
    return ok(201, {
      id,
      title: input.title,
      visibility: visibility ?? 'private',
      warnings,
      ...(stored
        ? { createdAt: stored.createdAt, updatedAt: stored.updatedAt }
        : {}),
    })
  }

  if (method === 'PUT' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    const { input, visibility, confirm, expectedUpdatedAt } =
      parseRecipeBody(req)
    // M22: the precondition is checked before anything is written.
    checkPrecondition(existing, expectedUpdatedAt)
    checkTierAllowed(visibility)
    const target = visibility as 'private' | 'public' | undefined
    const { warnings } = await applyWriteWithFlip(
      host,
      id,
      existing,
      target,
      confirm,
      () => host.updateRecipe(id, input),
    )
    const after = await host.getRecipe(id)
    return ok(200, {
      id,
      visibility: target ?? existing.visibility,
      updatedAt: after?.updatedAt ?? existing.updatedAt,
      warnings,
    })
  }

  if (method === 'PATCH' && isRecipes && seg.length === 3) {
    const id = seg[2]
    const existing = await host.getRecipe(id)
    if (!existing) {
      return fail(404, 'No recipe with that id exists in this cookbook.')
    }
    const { patch, visibility, confirm, expectedUpdatedAt } =
      parsePatchBody(req)
    // M22: the precondition is checked before anything is written.
    checkPrecondition(existing, expectedUpdatedAt)
    checkTierAllowed(visibility)
    const target = visibility as 'private' | 'public' | undefined
    const { warnings } = await applyWriteWithFlip(
      host,
      id,
      existing,
      target,
      confirm,
      // A visibility-only patch has no content to write; the flip
      // itself refreshes updatedAt.
      () =>
        Object.keys(patch).length > 0
          ? host.patchRecipe(id, patch)
          : Promise.resolve(),
    )
    const after = await host.getRecipe(id)
    return ok(200, {
      id,
      visibility: target ?? existing.visibility,
      updatedAt: after?.updatedAt ?? existing.updatedAt,
      warnings,
    })
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
      throw new LocalApiError(
        400,
        'Expected a JSON object with "importerId" and "text" or "url".',
      )
    }
    const r = raw as Record<string, unknown>
    if (typeof r.importerId !== 'string' || !r.importerId) {
      throw new LocalApiError(400, '"importerId" is required — the id of a registered importer.')
    }
    if (r.text !== undefined && typeof r.text !== 'string') {
      throw new LocalApiError(400, '"text" must be a string — the source text for the importer.')
    }
    if (r.url !== undefined && typeof r.url !== 'string') {
      throw new LocalApiError(400, '"url" must be a string — the page URL for the importer.')
    }
    const text = typeof r.text === 'string' ? r.text : undefined
    const url = typeof r.url === 'string' ? r.url.trim() : undefined
    if (text !== undefined && url !== undefined) {
      throw new LocalApiError(
        400,
        'Send either "text" or "url", not both — the importer reads one source.',
      )
    }
    if (text === undefined && url === undefined) {
      throw new LocalApiError(
        400,
        'Send "text" (the source text) or "url" (a page for the URL importer) — the importer needs a source.',
      )
    }
    if (url === '') {
      throw new LocalApiError(400, '"url" must not be empty.')
    }
    await ensurePluginsLoaded()
    // runImporter validates every recipe; one bad recipe fails the
    // whole import and nothing is saved (same atomicity as the UI).
    // M24: a URL source goes to the URL importer, and source
    // timestamps ride through from the importer and are kept on
    // create — a backup restores with its original times.
    const { recipes, warnings, timestamps } = await runImporter(
      r.importerId,
      url !== undefined
        ? { kind: 'url', url }
        : { kind: 'text', text: text as string },
    )
    const ids = await host.importRecipes(recipes, timestamps)
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
    if (e instanceof LocalApiError) return fail(e.status, e.message, e.details)
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
