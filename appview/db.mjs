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
 *    `q` matches the name OR the instructions (steps) — Int L10(a).
 *  - ingredient search is AND semantics over `ingredients_text` in the same
 *    FTS5 table (token-prefix match per ingredient token).
 *  - If FTS5 is unavailable in the local node:sqlite build, both fall back
 *    to LIKE-based matching with identical API semantics (ftsEnabled=false).
 *  - search() takes { limit, offset } (Int L2 pagination; limit is
 *    clamped to 100) and searchCount() returns the matching total, so
 *    callers can page through a result set instead of a silent top-100.
 */
import { DatabaseSync } from 'node:sqlite'

export const RECIPE_COLLECTION = 'kitchen.longtable.recipe'
export const PUBKEY_COLLECTION = 'kitchen.longtable.pubkey'

/** Split a string into lowercase alphanumeric FTS terms.
 * M5: Unicode-aware (\p{L}\p{N}) — the old [a-z0-9] split silently
 * dropped every non-ASCII term, so e.g. "café" searched as "caf".
 * Terms stay letters/digits only, so they remain safe to embed in the
 * FTS5 MATCH expression built by ftsColumnExpr. */
export function ftsTerms(str) {
  return String(str ?? '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
}

/** Escape a LIKE pattern fragment (M5): %, _ and the escape char itself
 * are literals in user input, never wildcards. Used with ESCAPE '\\'. */
export function escapeLikePattern(str) {
  return String(str ?? '').replace(/[%_\\]/g, '\\$&')
}

/** Build an FTS5 column-scoped prefix-match expression, or null if no terms. */
function ftsColumnExpr(column, terms) {
  if (terms.length === 0) return null
  // Each term is already reduced to letters/digits, so it is safe to embed.
  return terms.map((t) => `${column}:${t}*`).join(' ')
}

/**
 * Build an FTS5 MATCH expression for `q` over the name OR the steps
 * (Int L10a): every term must match the name or the instructions_text
 * column, terms AND together. The groups join with an explicit AND —
 * FTS5 rejects two parenthesised groups separated by bare whitespace
 * ("syntax error near (", verified against node:sqlite) — and the
 * multi-word AND semantics are the ones the name search already had.
 */
function ftsNameOrStepsExpr(terms) {
  if (terms.length === 0) return null
  return terms.map((t) => `(name:${t}* OR instructions_text:${t}*)`).join(' AND ')
}

function asArray(v) {
  return Array.isArray(v) ? v : []
}

function asIntOrNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : null
}

/** Normalize a lexicon-shaped recipe record + repo provenance into a row. */
export function recordToRow({ uri, did, rkey, cid, record, deviceKey }) {
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
    // Served back to clients so they can verify the device signature at
    // read time (response contract: deviceDid / deviceSignature /
    // deviceKey). device_key is the bound device public key, standard
    // base64 — byte-identical to the pubkey binding record's
    // devicePublicKey field — supplied by the caller, not the record.
    device_did: typeof record?.deviceDid === 'string' ? record.deviceDid : null,
    device_signature: typeof record?.deviceSignature === 'string' ? record.deviceSignature : null,
    device_key: typeof deviceKey === 'string' ? deviceKey : null,
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
    // Served so clients can carry the record's identity through search
    // results (S10). A summary still cannot be verified on its own —
    // the canonical hash needs the full record — so the client marks
    // list items unverified until opened; the id is here for the
    // open path and any future summary-level check.
    longtableId: row.longtable_id,
    deviceDid: row.device_did,
    deviceSignature: row.device_signature,
    deviceKey: row.device_key,
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
    deviceDid: row.device_did,
    deviceSignature: row.device_signature,
    deviceKey: row.device_key,
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
        updated_at TEXT,
        device_did TEXT,
        device_signature TEXT,
        device_key TEXT
      );
      CREATE INDEX IF NOT EXISTS recipes_by_did ON recipes(did);
    `)
    // Pre-C2 index DBs lack the device-signature columns: add them in
    // place. Rows indexed before this fix carry NULLs until their next
    // verified reconcile re-upserts them with signatures.
    for (const col of ['device_did TEXT', 'device_signature TEXT', 'device_key TEXT']) {
      const name = col.split(' ')[0]
      const exists = this.db
        .prepare('PRAGMA table_info(recipes)')
        .all()
        .some((c) => c.name === name)
      if (!exists) this.db.exec(`ALTER TABLE recipes ADD COLUMN ${col}`)
    }
    this.ftsEnabled = false
    try {
      this.db.exec(`
        CREATE VIRTUAL TABLE IF NOT EXISTS recipes_fts USING fts5(
          uri UNINDEXED, name, ingredients_text, tags_text, instructions_text
        );
      `)
      // Prove MATCH actually works, not just CREATE (some builds differ).
      this.db.prepare('SELECT uri FROM recipes_fts WHERE recipes_fts MATCH ? LIMIT 1').all('name:probe*')
      this.ftsEnabled = true
    } catch {
      this.ftsEnabled = false
    }
    // Int L10(a): an index DB built before the instructions_text
    // column existed still has the old 3-column FTS table (CREATE IF
    // NOT EXISTS is a no-op for it) — rebuild it from the recipes
    // table so ?q= matches steps on old databases too. Fresh DBs
    // already have the column and skip this entirely.
    if (this.ftsEnabled) {
      const ftsCols = this.db
        .prepare('PRAGMA table_info(recipes_fts)')
        .all()
        .map((c) => c.name)
      if (!ftsCols.includes('instructions_text')) {
        this.db.exec('DROP TABLE recipes_fts')
        this.db.exec(`
          CREATE VIRTUAL TABLE recipes_fts USING fts5(
            uri UNINDEXED, name, ingredients_text, tags_text, instructions_text
          );
        `)
        for (const row of this.db
          .prepare('SELECT uri, name, ingredients, tags, instructions FROM recipes')
          .all()) {
          let ingredients = []
          let tags = []
          let instructions = []
          try {
            ingredients = JSON.parse(row.ingredients)
          } catch {
            /* keep [] */
          }
          try {
            tags = JSON.parse(row.tags)
          } catch {
            /* keep [] */
          }
          try {
            instructions = JSON.parse(row.instructions)
          } catch {
            /* keep [] */
          }
          this.#insertFts(
            row.uri,
            row.name,
            (Array.isArray(ingredients) ? ingredients : []).join(' '),
            (Array.isArray(tags) ? tags : []).join(' '),
            (Array.isArray(instructions) ? instructions : []).join(' '),
          )
        }
      }
    }
  }

  #insertFts(uri, name, ingredientsText, tagsText, instructionsText) {
    if (!this.ftsEnabled) return
    this.db.prepare('DELETE FROM recipes_fts WHERE uri = ?').run(uri)
    this.db
      .prepare(
        'INSERT INTO recipes_fts (uri, name, ingredients_text, tags_text, instructions_text) VALUES (?, ?, ?, ?, ?)',
      )
      .run(uri, name, ingredientsText, tagsText, instructionsText)
  }

  #syncFts(row) {
    this.#insertFts(
      row.uri,
      row.name,
      row.ingredients.join(' '),
      row.tags.join(' '),
      row.instructions.join(' '),
    )
  }

  /**
   * Insert or update one verified recipe.
   * Returns true if the index changed (new row or different CID).
   */
  upsert(entry) {
    const row = recordToRow(entry)
    const existing = this.db
      .prepare('SELECT cid, device_did, device_signature, device_key FROM recipes WHERE uri = ?')
      .get(row.uri)
    if (
      existing &&
      existing.cid === row.cid &&
      existing.device_did === row.device_did &&
      existing.device_signature === row.device_signature &&
      existing.device_key === row.device_key
    ) {
      return false
    }
    // M6: the row write and the FTS sync are one transaction — a
    // crash/failure between them used to leave the index and the FTS
    // table disagreeing (row without terms, or terms without a row).
    this.db.exec('BEGIN IMMEDIATE')
    try {
      this.db
        .prepare(
          `INSERT INTO recipes (uri, did, rkey, cid, name, description, ingredients, instructions,
                                 prep, cook, yield, tags, images, longtable_id, created_at, updated_at,
                                 device_did, device_signature, device_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(uri) DO UPDATE SET
             did=excluded.did, rkey=excluded.rkey, cid=excluded.cid, name=excluded.name,
             description=excluded.description, ingredients=excluded.ingredients,
             instructions=excluded.instructions, prep=excluded.prep, cook=excluded.cook,
             yield=excluded.yield, tags=excluded.tags, images=excluded.images,
             longtable_id=excluded.longtable_id, created_at=excluded.created_at,
             updated_at=excluded.updated_at, device_did=excluded.device_did,
             device_signature=excluded.device_signature, device_key=excluded.device_key`,
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
          row.device_did,
          row.device_signature,
          row.device_key,
        )
      this.#syncFts(row)
      this.db.exec('COMMIT')
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    }
    return true
  }

  deleteByUri(uri) {
    // M6: row + FTS deletes are one transaction, like upsert.
    this.db.exec('BEGIN IMMEDIATE')
    try {
      const res = this.db.prepare('DELETE FROM recipes WHERE uri = ?').run(uri)
      if (this.ftsEnabled) {
        this.db.prepare('DELETE FROM recipes_fts WHERE uri = ?').run(uri)
      }
      this.db.exec('COMMIT')
      return Number(res.changes) > 0
    } catch (err) {
      try {
        this.db.exec('ROLLBACK')
      } catch {
        /* already rolled back */
      }
      throw err
    }
  }

  hasUri(uri) {
    return !!this.db.prepare('SELECT 1 FROM recipes WHERE uri = ?').get(uri)
  }

  listUrisByDid(did) {
    return this.db.prepare('SELECT uri FROM recipes WHERE did = ?').all(did).map((r) => r.uri)
  }

  /** The `images` array stored for one row (parsed, [] when absent/unparseable). */
  imagesForUri(uri) {
    const row = this.db.prepare('SELECT images FROM recipes WHERE uri = ?').get(uri)
    if (!row) return []
    try {
      const parsed = JSON.parse(row.images)
      return Array.isArray(parsed) ? parsed : []
    } catch {
      return []
    }
  }

  /**
   * H1 — every (did, cid) pair any indexed recipe references, for the
   * media cache's purgeUnreferenced(). CID extraction matches
   * media.mjs imageCids (ref.$link, else a bare string ref).
   */
  listImageRefs() {
    const refs = []
    const cidRe = /^[A-Za-z0-9]+$/
    for (const row of this.db.prepare('SELECT did, images FROM recipes').all()) {
      let images = []
      try {
        images = JSON.parse(row.images)
      } catch {
        continue
      }
      if (!Array.isArray(images)) continue
      for (const img of images) {
        const ref = img?.ref
        const cid = typeof ref?.$link === 'string' ? ref.$link : typeof ref === 'string' ? ref : null
        if (cid && cidRe.test(cid)) refs.push({ did: row.did, cid })
      }
    }
    return refs
  }

  /**
   * M12 (media gating) — true only when an indexed recipe of `did`
   * references blob `cid`. The /media/ handler uses this so the cache
   * can only be primed for blobs a real recipe points at, never as an
   * open fetch oracle for arbitrary (did, cid) pairs.
   */
  hasImage(did, cid) {
    for (const row of this.db.prepare('SELECT images FROM recipes WHERE did = ?').all(did)) {
      let images = []
      try {
        images = JSON.parse(row.images)
      } catch {
        continue
      }
      if (!Array.isArray(images)) continue
      for (const img of images) {
        const ref = img?.ref
        const c = typeof ref?.$link === 'string' ? ref.$link : typeof ref === 'string' ? ref : null
        if (c === cid) return true
      }
    }
    return false
  }

  /** Every distinct author DID in the index — the periodic/startup reconcile sweep re-verifies each one (N1/S2). */
  listDids() {
    return this.db.prepare('SELECT DISTINCT did FROM recipes').all().map((r) => r.did)
  }

  /**
   * Rows that predate device-signature verification (or were never
   * re-verified): at least one signature field is NULL. The HTTP layer
   * excludes these from serving until a reconcile re-verifies them (S2);
   * they stay in the store so the sweep can find their DID again.
   */
  countUnverified() {
    const row = this.db
      .prepare(
        'SELECT COUNT(*) AS n FROM recipes WHERE device_did IS NULL OR device_signature IS NULL OR device_key IS NULL',
      )
      .get()
    return Number(row.n)
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
    // M12: bounded like /search (LIMIT 100) — the unbounded author
    // listing was one unbounded read per DID.
    return this.db
      .prepare('SELECT * FROM recipes WHERE did = ? ORDER BY updated_at DESC, name ASC LIMIT 100')
      .all(did)
      .map(rowToSummary)
  }

  /**
   * Build the WHERE/JOIN fragments for a search, shared by search()
   * and searchCount() so the total always matches the page. Returns
   * { joinSql, whereSql, params, orderSql, ftsJoin } where `ftsJoin`
   * marks the FTS MATCH query shape (JOIN + rank ordering).
   */
  #searchQuery({ q, ingredients, verifiedOnly = false } = {}) {
    const ingList = asArray(ingredients).map((s) => String(s).trim()).filter(Boolean)
    const qTerms = q ? ftsTerms(q) : []
    // S2: the serving rule as SQL — a row counts as a result only
    // when it carries all three device-signature fields. The HTTP
    // layer passes verifiedOnly so LIMIT/OFFSET apply after the
    // filter, not before it (filtering in JS would shift page
    // boundaries); direct index callers keep the old unfiltered view.
    const verifiedSql = verifiedOnly
      ? 'recipes.device_did IS NOT NULL AND recipes.device_signature IS NOT NULL AND recipes.device_key IS NOT NULL'
      : null

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
        // JOIN so results come back ranked by FTS bm25 rank on the match.
        // Int L10(a): q matches the name OR the steps.
        return {
          ftsJoin: true,
          joinSql: 'JOIN recipes_fts ON recipes_fts.uri = recipes.uri',
          whereSql: ['recipes_fts MATCH ?', ...ingClauses, ...(verifiedSql ? [verifiedSql] : [])].join(' AND '),
          params: [ftsNameOrStepsExpr(qTerms), ...ingParams],
          orderSql: 'ORDER BY recipes_fts.rank ASC',
        }
      }
      return {
        ftsJoin: false,
        joinSql: '',
        whereSql: [...ingClauses, ...(verifiedSql ? [verifiedSql] : [])].join(' AND '),
        params: ingParams,
        orderSql: 'ORDER BY name ASC',
      }
    }

    // Fallback (no FTS5): LIKE with identical API semantics.
    // M5: user-supplied %/_ are escaped (ESCAPE '\') so a query for
    // "100%" cannot match "1000" — the old fallback pushed them raw.
    const clauses = []
    const params = []
    if (q) {
      // Int L10(a): ?q= matches steps too, like the FTS path.
      const pat = `%${escapeLikePattern(String(q).toLowerCase())}%`
      clauses.push("(lower(name) LIKE ? ESCAPE '\\' OR lower(instructions) LIKE ? ESCAPE '\\')")
      params.push(pat, pat)
    }
    for (const ing of ingList) {
      clauses.push("lower(ingredients) LIKE ? ESCAPE '\\'")
      params.push(`%${escapeLikePattern(ing.toLowerCase())}%`)
    }
    if (verifiedSql) clauses.push(verifiedSql)
    return { ftsJoin: false, joinSql: '', whereSql: clauses.join(' AND '), params, orderSql: 'ORDER BY name ASC' }
  }

  /**
   * Search. `q` matches the recipe name or its steps (FTS-ranked when
   * available); `ingredients` is a list of ingredient strings, ALL of
   * which must match. Both combine (AND). `limit` (default 100, clamped
   * to 100) + `offset` (default 0) page through the matches — Int L2.
   * Returns summary rows.
   */
  search({ q, ingredients, limit = 100, offset = 0, verifiedOnly = false } = {}) {
    const lim = Math.min(100, Math.max(1, Math.trunc(Number(limit)) || 100))
    const off = Math.max(0, Math.trunc(Number(offset)) || 0)
    const query = this.#searchQuery({ q, ingredients, verifiedOnly })
    const where = query.whereSql ? `WHERE ${query.whereSql}` : ''
    if (query.ftsJoin) {
      const sql = `SELECT recipes.* FROM recipes ${query.joinSql} ${where} ${query.orderSql} LIMIT ? OFFSET ?`
      return this.db
        .prepare(sql)
        .all(...query.params, lim, off)
        .map(rowToSummary)
    }
    const sql = `SELECT * FROM recipes ${where} ${query.orderSql} LIMIT ? OFFSET ?`
    return this.db.prepare(sql).all(...query.params, lim, off).map(rowToSummary)
  }

  /**
   * Total rows matching a search (same filters as search()) — Int L2.
   * The HTTP layer returns this alongside the page so clients can
   * page to the end instead of guessing at a silent top-100.
   */
  searchCount({ q, ingredients, verifiedOnly = false } = {}) {
    const query = this.#searchQuery({ q, ingredients, verifiedOnly })
    const where = query.whereSql ? `WHERE ${query.whereSql}` : ''
    if (query.ftsJoin) {
      const sql = `SELECT COUNT(*) AS n FROM recipes ${query.joinSql} ${where}`
      return Number(this.db.prepare(sql).get(...query.params).n)
    }
    const sql = `SELECT COUNT(*) AS n FROM recipes ${where}`
    return Number(this.db.prepare(sql).get(...query.params).n)
  }

  close() {
    this.db.close()
  }
}
