/**
 * longtable-json export — Wave 3 C3 (export half).
 *
 * A versioned, human-readable JSON file holding the user's recipes and
 * their friends list (name + DID only). It is the same shape the
 * existing `longtable-json` importer already reads (`{ "recipes": [...] }`
 * — see src/importers/jsonImporter.ts), so an export round-trips through
 * the Import panel with no new import code: export → Import → the same
 * recipes land back in the cookbook.
 *
 * What is deliberately NOT in here: anything secret. The file is
 * plaintext by design (it is meant to be opened, read, and handed to the
 * importer), so it carries no pair secrets, no key-vault entries, and no
 * identity key. A friends-only recipe exported here keeps its
 * `visibility` marker, but the keys that make the share work live only
 * in the encrypted backup (src/backup/backup.ts) — restoring sharing
 * from a bare JSON export alone needs re-pairing and re-sharing. The
 * file says so in its own `notes` field so nobody mistakes it for a
 * full backup.
 */
import type { KeyValueStore } from '../identity/identity'
import { listFriends, type FriendRecord } from '../friends/friends'
import { getOrCreateIndex, getRecipe, listRecipes } from '../store/recipes'
import type { YjsStore } from '../store/repo'
import type { Recipe } from '../types'

export const EXPORT_FORMAT = 'longtable-json' as const
export const EXPORT_VERSION = 1 as const

/** One recipe as it appears in the export file. */
export interface ExportedRecipe {
  /** Stable recipe id (the Yjs doc guid). The importer ignores it — a
   *  plain import mints fresh ids — but the encrypted backup restores
   *  it, and keeping it here makes the two formats visibly the same
   *  collection. */
  id: string
  title: string
  ingredients: string[]
  steps: string[]
  photos: string[]
  prepMinutes?: number
  cookMinutes?: number
  /** Present only when the recipe is not private. */
  visibility?: 'private' | 'friends-only' | 'public'
  createdAt: string
  updatedAt: string
}

export interface ExportedFriend {
  name: string
  did: string
}

export interface LongtableExport {
  format: typeof EXPORT_FORMAT
  version: typeof EXPORT_VERSION
  exportedAt: string
  /** Plain-language scope note, so the file is self-describing. */
  notes: string
  recipes: ExportedRecipe[]
  /** Name + DID only — never pair secrets (see module header). */
  friends: ExportedFriend[]
}

export const EXPORT_NOTES =
  'Longtable recipe export. Recipes only, plus friends by name and DID. ' +
  'This file is NOT a full backup: it holds no identity key, no key-vault ' +
  'entries, and no friend pair secrets, so friends-only shares cannot be ' +
  'restored from it alone. Use the encrypted backup (Backup panel) for that.'

export class ExportError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ExportError'
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === 'string')
}

function isVisibility(v: unknown): v is ExportedRecipe['visibility'] {
  return v === 'private' || v === 'friends-only' || v === 'public'
}

/** Build the export document from already-loaded recipes and friends. */
export function buildExport(
  recipes: { id: string; recipe: Recipe }[],
  friends: FriendRecord[],
  exportedAt: string = new Date().toISOString(),
): LongtableExport {
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt,
    notes: EXPORT_NOTES,
    recipes: recipes.map(({ id, recipe }) => ({
      id,
      title: recipe.title,
      ingredients: [...recipe.ingredients],
      steps: [...recipe.steps],
      photos: [...recipe.photos],
      ...(recipe.prepMinutes !== undefined ? { prepMinutes: recipe.prepMinutes } : {}),
      ...(recipe.cookMinutes !== undefined ? { cookMinutes: recipe.cookMinutes } : {}),
      ...(recipe.visibility !== undefined ? { visibility: recipe.visibility } : {}),
      createdAt: recipe.createdAt,
      updatedAt: recipe.updatedAt,
    })),
    friends: friends.map((f) => ({ name: f.name, did: f.did })),
  }
}

/** Serialize an export document (2-space JSON, trailing newline). */
export function serializeExport(exp: LongtableExport): string {
  return JSON.stringify(exp, null, 2) + '\n'
}

/**
 * Parse and validate an export document. Throws ExportError on anything
 * malformed. Unknown fields are ignored (forward compatibility); the
 * recipe content itself is validated field by field, mirroring the
 * importer contract's limits.
 */
export function parseExport(text: string): LongtableExport {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new ExportError('That file is not valid JSON — check the file and try again.')
  }
  if (!isRecord(parsed)) {
    throw new ExportError('That file is not a Longtable export (expected a JSON object).')
  }
  if (parsed.format !== EXPORT_FORMAT || parsed.version !== EXPORT_VERSION) {
    throw new ExportError(
      `That file is not a ${EXPORT_FORMAT} v${EXPORT_VERSION} export ` +
        `(found format ${String(parsed.format)} v${String(parsed.version)}).`,
    )
  }
  if (typeof parsed.exportedAt !== 'string' || !parsed.exportedAt) {
    throw new ExportError('That export file has no export date.')
  }
  if (!Array.isArray(parsed.recipes)) {
    throw new ExportError('That export file has no recipes list.')
  }
  const recipes: ExportedRecipe[] = parsed.recipes.map((raw, i) => {
    const where = `export recipe ${i + 1}`
    if (!isRecord(raw)) throw new ExportError(`${where}: not a JSON object.`)
    if (typeof raw.id !== 'string' || !raw.id) {
      throw new ExportError(`${where}: missing an id.`)
    }
    if (typeof raw.title !== 'string' || !raw.title.trim()) {
      throw new ExportError(`${where}: missing a title.`)
    }
    if (!isStringArray(raw.ingredients) || !isStringArray(raw.steps)) {
      throw new ExportError(`${where}: ingredients and steps must be lists of text.`)
    }
    if (raw.photos !== undefined && !isStringArray(raw.photos)) {
      throw new ExportError(`${where}: photos must be a list of text.`)
    }
    for (const key of ['prepMinutes', 'cookMinutes'] as const) {
      const v = raw[key]
      if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
        throw new ExportError(`${where}: "${key}" must be a number of minutes (0 or more).`)
      }
    }
    if (raw.visibility !== undefined && !isVisibility(raw.visibility)) {
      throw new ExportError(`${where}: unknown visibility "${String(raw.visibility)}".`)
    }
    if (typeof raw.createdAt !== 'string' || typeof raw.updatedAt !== 'string') {
      throw new ExportError(`${where}: missing created/updated timestamps.`)
    }
    return {
      id: raw.id,
      title: raw.title,
      ingredients: raw.ingredients,
      steps: raw.steps,
      photos: (raw.photos as string[] | undefined) ?? [],
      ...(typeof raw.prepMinutes === 'number' ? { prepMinutes: raw.prepMinutes } : {}),
      ...(typeof raw.cookMinutes === 'number' ? { cookMinutes: raw.cookMinutes } : {}),
      ...(isVisibility(raw.visibility) ? { visibility: raw.visibility } : {}),
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
    }
  })
  if (!Array.isArray(parsed.friends)) {
    throw new ExportError('That export file has no friends list.')
  }
  const friends: ExportedFriend[] = parsed.friends.map((raw, i) => {
    if (
      !isRecord(raw) ||
      typeof raw.name !== 'string' ||
      typeof raw.did !== 'string' ||
      !raw.did.startsWith('did:key:z')
    ) {
      throw new ExportError(`export friend ${i + 1}: expected a name and a did:key DID.`)
    }
    return { name: raw.name, did: raw.did }
  })
  return {
    format: EXPORT_FORMAT,
    version: EXPORT_VERSION,
    exportedAt: parsed.exportedAt,
    notes: typeof parsed.notes === 'string' ? parsed.notes : '',
    recipes,
    friends,
  }
}

/**
 * Collect the user's current recipes + friends into an export document.
 * Reads through the store's existing accessors only; touches nothing.
 */
export async function collectExport(
  repo: YjsStore,
  kv: KeyValueStore,
): Promise<LongtableExport> {
  const index = await getOrCreateIndex(repo, kv)
  const summaries = await listRecipes(index)
  const recipes: { id: string; recipe: Recipe }[] = []
  for (const s of summaries) {
    const recipe = await getRecipe(repo, s.url)
    if (recipe) recipes.push({ id: s.id, recipe })
  }
  return buildExport(recipes, listFriends(kv))
}

/** Suggested filename for a download/share, e.g. `longtable-export-2026-11-21.json`. */
export function exportFileName(exportedAt: string = new Date().toISOString()): string {
  return `longtable-export-${exportedAt.slice(0, 10)}.json`
}
