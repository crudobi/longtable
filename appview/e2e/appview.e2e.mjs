/**
 * AppView e2e against the local ATProto testnet.
 *
 *   npm run test:e2e
 *
 * Requires the testnet to be up (PDS on :2583, PLC on :2582) and seeded
 * accounts at /home/devbox/ops/longtable-atproto/accounts.json
 * ({author:{handle,password,did}, attacker:{handle,password,did}}).
 *
 * Flow: start the AppView in-process on :3211 with a temp DB -> author
 * publishes a recipe -> poll search until the firehose->verify->index path
 * surfaces it (latency printed) -> attacker publishes a same-named recipe
 * (both must appear, each under its own DID) -> ingestClaim a forged record
 * in the author's name (must be rejected, never searchable) -> author
 * deletes the record (must disappear from search).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AtpAgent } from '@atproto/api'
import { createAppView } from '../server.mjs'

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const PLC_URL = process.env.PLC_URL ?? 'http://localhost:2582'
const PORT = Number(process.env.APPVIEW_E2E_PORT ?? 3211)
const BASE = `http://localhost:${PORT}`
const ACCOUNTS_FILE =
  process.env.ACCOUNTS_FILE ?? '/home/devbox/ops/longtable-atproto/accounts.json'
const COLLECTION = 'kitchen.longtable.recipe'
const TIMEOUT_MS = 90_000

let failures = 0
function check(label, cond, detail = '') {
  if (cond) {
    console.log(`PASS ${label}`)
  } else {
    failures++
    console.log(`FAIL ${label}${detail ? ` — ${detail}` : ''}`)
  }
}

async function getJson(p) {
  const res = await fetch(`${BASE}${p}`)
  if (!res.ok) throw new Error(`GET ${p} -> HTTP ${res.status}`)
  return res.json()
}

async function waitFor(label, fn, timeoutMs = TIMEOUT_MS) {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return { value: v, ms: Date.now() - start }
    } catch {
      // not yet; keep polling
    }
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for: ${label}`)
    await new Promise((r) => setTimeout(r, 500))
  }
}

function recipeRecord(name, longtableId, ingredients) {
  const now = new Date().toISOString()
  return {
    $type: COLLECTION,
    name,
    description: 'e2e recipe',
    ingredients,
    instructions: ['Prep.', 'Cook.', 'Serve.'],
    tags: ['e2e'],
    longtableId,
    createdAt: now,
    updatedAt: now,
  }
}

async function login(account) {
  const agent = new AtpAgent({ service: PDS_URL })
  await agent.login({ identifier: account.handle, password: account.password })
  return agent
}

async function main() {
  // Gate: testnet must be up.
  try {
    const h = await fetch(`${PDS_URL}/xrpc/_health`)
    if (!h.ok) throw new Error(`HTTP ${h.status}`)
  } catch (err) {
    console.log(`FAIL testnet PDS not reachable at ${PDS_URL} (${err.message}) — is the testnet up?`)
    process.exit(1)
  }
  const accounts = JSON.parse(fs.readFileSync(ACCOUNTS_FILE, 'utf8'))
  const { author, attacker } = accounts
  if (!author?.did || !attacker?.did) {
    console.log(`FAIL accounts file ${ACCOUNTS_FILE} missing author/attacker DIDs`)
    process.exit(1)
  }
  console.log(`author=${author.did} attacker=${attacker.did}`)

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'appview-e2e-'))
  const app = createAppView({
    dbPath: path.join(tmpDir, 'appview.db'),
    pdsUrl: PDS_URL,
    plcUrl: PLC_URL,
  })
  await app.listen(PORT)
  app.ingestor.startFirehose()
  console.log(`appview on :${PORT}, db=${tmpDir}/appview.db, fts5=${app.index.ftsEnabled}`)

  let authorUri, authorRkey, attackerUri, attackerRkey
  try {
    const health = await getJson('/health')
    check('health endpoint', health.ok === true)

    // --- author publishes ---
    const authorAgent = await login(author)
    const t0 = Date.now()
    const created = await authorAgent.com.atproto.repo.createRecord({
      repo: author.did,
      collection: COLLECTION,
      record: recipeRecord('AppView Borscht', 'e2e-borscht-author', ['3 beets', '1 onion']),
    })
    authorUri = created.data.uri
    authorRkey = authorUri.split('/').pop()
    console.log(`author published ${authorUri}`)

    const found = await waitFor('author recipe in /search?q=Borscht', async () => {
      const s = await getJson('/search?q=Borscht')
      return s.results.find((r) => r.uri === authorUri)
    })
    console.log(`ingest latency (publish -> searchable): ${Date.now() - t0}ms (poll wait ${found.ms}ms)`)
    check('author recipe searchable by name', !!found.value)
    check('author recipe attributed to author DID', found.value.did === author.did)

    const byIng = await getJson('/search?ingredients=beets,onion')
    check(
      'author recipe searchable by ingredients AND (beets,onion)',
      byIng.results.some((r) => r.uri === authorUri),
      JSON.stringify(byIng.results.map((r) => r.uri)),
    )
    const byIngMiss = await getJson('/search?ingredients=beets,rice')
    check(
      'ingredient AND excludes non-matching (beets,rice)',
      !byIngMiss.results.some((r) => r.uri === authorUri),
    )

    const full = await getJson(`/recipe/${encodeURIComponent(author.did)}/${authorRkey}`)
    check('GET /recipe returns full record', full.name === 'AppView Borscht' && full.did === author.did)

    // --- attacker publishes a same-named recipe in their OWN repo ---
    const attackerAgent = await login(attacker)
    const created2 = await attackerAgent.com.atproto.repo.createRecord({
      repo: attacker.did,
      collection: COLLECTION,
      record: recipeRecord('AppView Borscht', 'e2e-borscht-attacker', ['2 beets', '1 carrot']),
    })
    attackerUri = created2.data.uri
    attackerRkey = attackerUri.split('/').pop()
    console.log(`attacker published ${attackerUri}`)

    const both = await waitFor('both recipes in search', async () => {
      const s = await getJson('/search?q=Borscht')
      const a = s.results.find((r) => r.uri === authorUri)
      const b = s.results.find((r) => r.uri === attackerUri)
      return a && b ? { a, b } : null
    })
    check('same-named recipes from both authors are searchable', !!both.value)
    check(
      'authorship comes from the repo, never record content',
      both.value.a.did === author.did && both.value.b.did === attacker.did,
      `author-row did=${both.value.a.did}, attacker-row did=${both.value.b.did}`,
    )
    const authorPage = await getJson(`/author/${encodeURIComponent(attacker.did)}`)
    check(
      'GET /author/:did lists only that author',
      authorPage.results.length >= 1 && authorPage.results.every((r) => r.did === attacker.did),
    )

    // --- forged claim: a record in the author's name that was never in their repo ---
    const statsBefore = await getJson('/stats')
    const forged = recipeRecord('Forged Borscht', 'e2e-forged', ['99 beets'])
    const claim = await app.ingestor.ingestClaim({
      did: author.did,
      collection: COLLECTION,
      rkey: 'forgedborscht1',
      record: forged,
    })
    check('ingestClaim rejects the forged record', claim.indexed === false, JSON.stringify(claim))
    const forgedSearch = await getJson('/search?q=Forged')
    check('forged recipe absent from search', forgedSearch.results.length === 0)
    const stats = await getJson('/stats')
    check('stats.rejected >= 1 after forged claim', stats.rejected >= 1, JSON.stringify(stats))
    check(
      'forged claim indexed nothing (total unchanged)',
      stats.total === statsBefore.total,
      `before=${statsBefore.total} after=${stats.total}`,
    )

    // --- author deletes -> reconcile diff removes it from search ---
    await authorAgent.com.atproto.repo.deleteRecord({
      repo: author.did,
      collection: COLLECTION,
      rkey: authorRkey,
    })
    console.log(`author deleted ${authorUri}`)
    await waitFor('author recipe gone from search', async () => {
      const s = await getJson('/search?q=Borscht')
      return !s.results.some((r) => r.uri === authorUri) ? true : null
    })
    check('deleted recipe disappears from search', true)
    const after = await getJson('/search?q=Borscht')
    check('attacker recipe still searchable after author delete', after.results.some((r) => r.uri === attackerUri))
  } catch (err) {
    failures++
    console.log(`FAIL e2e error: ${err?.stack ?? err}`)
  } finally {
    // Best-effort cleanup so reruns start clean: delete the attacker's
    // record, plus any 'AppView Borscht' records left in the author's repo
    // by an earlier interrupted run.
    try {
      if (attackerUri) {
        const attackerAgent = await login(attacker)
        await attackerAgent.com.atproto.repo.deleteRecord({
          repo: attacker.did,
          collection: COLLECTION,
          rkey: attackerRkey,
        })
      }
    } catch {
      // ignore cleanup errors
    }
    try {
      const authorAgent = await login(author)
      const listed = await authorAgent.com.atproto.repo.listRecords({
        repo: author.did,
        collection: COLLECTION,
        limit: 100,
      })
      for (const rec of listed.data.records) {
        if (rec.value?.name === 'AppView Borscht') {
          await authorAgent.com.atproto.repo.deleteRecord({
            repo: author.did,
            collection: COLLECTION,
            rkey: rec.uri.split('/').pop(),
          })
        }
      }
    } catch {
      // ignore cleanup errors
    }
    await app.close()
    fs.rmSync(tmpDir, { recursive: true, force: true })
  }

  console.log(failures === 0 ? 'E2E RESULT: ALL PASS' : `E2E RESULT: ${failures} FAILURE(S)`)
  process.exit(failures === 0 ? 0 : 1)
}

await main()
