/**
 * RecipeIndex — SQLite (node:sqlite) store for verified Longtable recipes.
 *
 * The index is a *derived* view: rows enter it only from a signature-verified
 * repo state (see verify.mjs / ingest.mjs). Nothing in this file trusts
 * record content for authorship — `did` always comes from the repo that was
 * reconciled, never from the record body.
 *
 * Search:
 *  - name search uses the FTS5 virtual table `recipes_fts` (ranked, bm25).
 *  - ingredient search is AND semantics over `ingredients_text` in the same
 *    FTS5 table (token-prefix match per ingredient token).
 *  - If FTS5 is unavailable in the local node:sqlite build, both fall back
 *    to LIKE-based matching with identical API semantics (ftsEnabled=false).
 */
import { DatabaseSync } from 'node:sqlite'

export const RECIPE_COLLECTION = 'kitchen.longtable.recipe'
export const PUBKEY_COLLECTION = 'kitchen.longtable.pubkey'

/** Split a string into lowercase alphanumeric FTS terms. */
export function ftsTerms(str) {
  return String(str ?? '')
    .toLowerCase()
    .split(/[^a-z0-9]+/i)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Build an FTS5 column-scoped prefix-match expression, or null if no terms. */
function ftsColumnExpr(column, terms) {
  if (terms.length === 0) return null
  // Each term is already reduced to [a-z0-9], so it is safe to embed.
  return terms.map((t) => `${column}:${t}*`).join(' ')
}

function asArray(v) {
  return Array.isArray(v) ? v : []
}

function asIntOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
}

/** Normalize a lexicon-shaped recipe record + repo provenance into a row. */
export function recordToRow({ uri, did, rkey, cid, record }) {
  return {
    uri,
    did,
    rkey,
    cid: cid ?? null,
    name: typeof record?.name === 'string' ? record.name : '',
    description: typeof record?.description === 'string' ? record.description : null,
    ingredients: asArray(record?.ingredients).map(String),
    instructions: asArray(record?.instructions).map(String),
    prep: asIntOrNull(record?.prepTimeMinutes),
    cook: asIntOrNull(record?.cookTimeMinutes),
    yield: typeof record?.recipeYield === 'string' ? record.recipeYield : null,
    tags: asArray(record?.tags).map(String),
    images: asArray(record?.images),
    longtable_id: typeof record?.longtableId === 'string' ? record.longtableId : null,
    created_at: typeof record?.createdAt === 'string' ? record.createdAt : null,
    updated_at:
      typeof record?.updatedAt === 'string'
        ? record.updatedAt
        : typeof record?.createdAt === 'string'
          ? record.createdAt
          : null,
  }
}

function rowToSummary(row) {
  return {
    uri: row.uri,
    did: row.did,
    rkey: row.rkey,
    name: row.name,
    ingredients: JSON.parse(row.ingredients),
    tags: JSON.parse(row.tags),
    updatedAt: row.updated_at,
  }
}

function rowToFull(row) {
  return {
    uri: row.uri,
    did: row.did,
    rkey: row.rkey,
    cid: row.cid,
    name: row.name,
    description: row.description,
    ingredients: JSON.parse(row.ingredients),
    instructions: JSON.parse(row.instructions),
    prepTimeMinutes: row.prep,
    cookTimeMinutes: row.cook,
    recipeYield: row.yield,
    tags: JSON.parse(row.tags),
    images: JSON.parse(row.images),
    longtableId: row.longtable_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export class RecipeIndex {
  constructor(dbPath) {
    this.db = new DatabaseSync(dbPath)
    if (dbPath !== ':memory:') {
      try {
        this.db.exec('PRAGMA journal_mode = WAL')
      } catch {
        // WAL is an optimization only; in-memory / exotic filesystems still work.
      }
    }
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS recipes (
        uri TEXT PRIMARY KEY,
        did TEXT NOT NULL,
        rkey TEXT NOT NULL,
        cid TEXT,
        name TEXT NOT NULL DEFAULT '',
        description TEXT,
        ingredients TEXT NOT NULL DEFAULT '[]',
        instructions TEXT NOT NULL DEFAULT '[]',
        prep INTEGER,
        cook INTEGER,
        yield TEXT,
        tags TEXT NOT NULL DEFAULT '[]',
        images TEXT NOT NULL DEFAULT '[]',
        longtable_id TEXT,
        created_at TEXT,
        updated_at TEXT
      );
      CREATE INDEX IF NOT EXISTS recipes_by_did ON recipes(did);
    `)
    this.ftsEnabled = false
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
          uri UNINDEXED, name, ingredients_text, tags_text
        );
      `)
      // Prove MATCH actually works, not just CREATE (some builds differ).
      this.db.prepare('SELECT uri FROM recipes_fts WHERE recipes_fts MATCH ? LIMIT 1').all('name:probe*')
      this.ftsEnabled = true
    } catch {
      this.ftsEnabled = false
    }
  }

  #syncFts(row) {
    if (!this.ftsEnabled) return
    this.db.prepare('DELETE FROM recipes_fts WHERE uri = ?').run(row.uri)
    this.db
      .prepare('INSERT INTO recipes_fts (uri, name, ingredients_text, tags_text) VALUES (?, ?, ?, ?)')
      .run(row.uri, row.name, row.ingredients.join(' '), row.tags.join(' '))
  }

  /**
   * Insert or update one verified recipe.
   * Returns true if the index changed (new row or different CID).
   */
  upsert(entry) {
    const row = recordToRow(entry)
    const existing = this.db.prepare('SELECT cid FROM recipes WHERE uri = ?').get(row.uri)
    if (existing && existing.cid === row.cid) return false
    this.db
      .prepare(
        `INSERT INTO recipes (uri, did, rkey, cid, name, description, ingredients, instructions,
                               prep, cook, yield, tags, images, longtable_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(uri) DO UPDATE SET
           did=excluded.did, rkey=excluded.rkey, cid=excluded.cid, name=excluded.name,
           description=excluded.description, ingredients=excluded.ingredients,
           instructions=excluded.instructions, prep=excluded.prep, cook=excluded.cook,
           yield=excluded.yield, tags=excluded.tags, images=excluded.images,
           longtable_id=excluded.longtable_id, created_at=excluded.created_at,
           updated_at=excluded.updated_at`,
      )
      .run(
        row.uri,
        row.did,
        row.rkey,
        row.cid,
        row.name,
        row.description,
        JSON.stringify(row.ingredients),
        JSON.stringify(row.instructions),
        row.prep,
        row.cook,
        row.yield,
        JSON.stringify(row.tags),
        JSON.stringify(row.images),
        row.longtable_id,
        row.created_at,
        row.updated_at,
      )
    this.#syncFts(row)
    return true
  }

  deleteByUri(uri) {
    const res = this.db.prepare('DELETE FROM recipes WHERE uri = ?').run(uri)
    if (this.ftsEnabled) {
      this.db.prepare('DELETE FROM recipes_fts WHERE uri = ?').run(uri)
    }
    return Number(res.changes) > 0
  }

  hasUri(uri) {
    return !!this.db.prepare('SELECT 1 FROM recipes WHERE uri = ?').get(uri)
  }

  listUrisByDid(did) {
    return this.db.prepare('SELECT uri FROM recipes WHERE did = ?').all(did).map((r) => r.uri)
  }

  count() {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM recipes').get()
    return Number(row.n)
  }

  getRecipe(did, rkey) {
    const row = this.db
      .prepare('SELECT * FROM recipes WHERE did = ? AND rkey = ?')
      .get(did, rkey)
    return row ? rowToFull(row) : null
  }

  byAuthor(did) {
    return this.db
      .prepare('SELECT * FROM recipes WHERE did = ? ORDER BY updated_at DESC, name ASC')
      .all(did)
      .map(rowToSummary)
  }

  /**
   * Search. `q` matches the recipe name (FTS-ranked when available);
   * `ingredients` is a list of ingredient strings, ALL of which must match.
   * Both combine (AND). Returns summary rows, max 100.
   */
  search({ q, ingredients } = {}) {
    const ingList = asArray(ingredients).map((s) => String(s).trim()).filter(Boolean)
    const qTerms = q ? ftsTerms(q) : []

    if (this.ftsEnabled && (qTerms.length > 0 || ingList.length > 0)) {
      const ingClauses = []
      const ingParams = []
      for (const ing of ingList) {
        const terms = ftsTerms(ing)
        if (terms.length === 0) continue
        ingClauses.push('recipes.uri IN (SELECT uri FROM recipes_fts WHERE recipes_fts MATCH ?)')
        ingParams.push(ftsColumnExpr('ingredients_text', terms))
      }
      if (qTerms.length > 0) {
        // JOIN so results come back ranked by FTS bm25 rank on the name match.
        const sql = `SELECT recipes.* FROM recipes
          JOIN recipes_fts ON recipes_fts.uri = recipes.uri
          WHERE recipes_fts MATCH ?
          ${ingClauses.length ? 'AND ' + ingClauses.join(' AND ') : ''}
          ORDER BY recipes_fts.rank ASC LIMIT 100`
        return this.db
          .prepare(sql)
          .all(ftsColumnExpr('name', qTerms), ...ingParams)
          .map(rowToSummary)
      }
      const sql = `SELECT * FROM recipes ${ingClauses.length ? 'WHERE ' + ingClauses.join(' AND ') : ''} ORDER BY name ASC LIMIT 100`
      return this.db.prepare(sql).all(...ingParams).map(rowToSummary)
    }

    // Fallback (no FTS5): LIKE with identical API semantics.
    const clauses = []
    const params = []
    if (q) {
      clauses.push('lower(name) LIKE ?')
      params.push(`%${String(q).toLowerCase()}%`)
    }
    for (const ing of ingList) {
      clauses.push('lower(ingredients) LIKE ?')
      params.push(`%${ing.toLowerCase()}%`)
    }
    const sql = `SELECT * FROM recipes ${clauses.length ? 'WHERE ' + clauses.join(' AND ') : ''} ORDER BY name ASC LIMIT 100`
    return this.db.prepare(sql).all(...params).map(rowToSummary)
  }

  close() {
    this.db.close()
  }
}
