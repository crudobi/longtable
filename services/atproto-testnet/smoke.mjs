// Smoke test for the local ATProto testnet.
//
// Logs in as the seeded author and round-trips a kitchen.longtable.recipe
// record through the real PDS XRPC repo API:
//   login -> putRecord -> getRecord -> listRecords -> deleteRecord
// Prints PASS/FAIL per step and exits non-zero if any step fails.
//
// Credentials/DID are read from the seed output
// (/home/devbox/ops/longtable-atproto/accounts.json), falling back to the
// well-known seed values. Run `npm run seed` first (and re-run it after
// every testnet restart — DIDs are ephemeral).
//
// @atproto/api is CommonJS, so it is loaded via createRequire.

import { createRequire } from 'node:module'
import { readFile } from 'node:fs/promises'

const require = createRequire(import.meta.url)
const { BskyAgent } = require('@atproto/api')

const PDS_URL = 'http://localhost:2583'
const ACCOUNTS_FILE = '/home/devbox/ops/longtable-atproto/accounts.json'
const COLLECTION = 'kitchen.longtable.recipe'
const RKEY = 'smoke-1'

let failures = 0
function step(name, ok, detail) {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) failures++
}

let author = { handle: 'olga.test', password: process.env.LT_SEED_PASSWORD ?? null, did: null }
try {
  const parsed = JSON.parse(await readFile(ACCOUNTS_FILE, 'utf8'))
  if (parsed.author) author = { ...author, ...parsed.author }
} catch {
  console.log(`[smoke] no accounts file at ${ACCOUNTS_FILE}; run seed first (or set LT_SEED_PASSWORD)`)
}

const agent = new BskyAgent({ service: PDS_URL })

// 1. login
try {
  const res = await agent.login({
    identifier: author.handle,
    password: author.password,
  })
  author.did = res.data.did
  step('login', true, `${author.handle} -> ${author.did}`)
} catch (err) {
  step('login', false, err.message)
  console.log(`SMOKE FAILED (${failures} failing step(s))`)
  process.exit(1)
}

const did = author.did
const record = {
  $type: COLLECTION,
  name: 'Smoke Soup',
  ingredients: ['1 onion'],
  instructions: ['Chop.'],
  createdAt: new Date().toISOString(),
  longtableId: RKEY,
}

// 2. putRecord
try {
  const res = await agent.com.atproto.repo.putRecord({
    repo: did,
    collection: COLLECTION,
    rkey: RKEY,
    record,
  })
  step('putRecord', !!res.data.uri, res.data.uri)
} catch (err) {
  step('putRecord', false, err.message)
}

// 3. getRecord
try {
  const res = await agent.com.atproto.repo.getRecord({
    repo: did,
    collection: COLLECTION,
    rkey: RKEY,
  })
  const v = res.data.value
  const ok =
    v.name === 'Smoke Soup' &&
    v.longtableId === RKEY &&
    Array.isArray(v.ingredients) &&
    v.ingredients[0] === '1 onion'
  step('getRecord', ok, `name=${v.name} longtableId=${v.longtableId}`)
} catch (err) {
  step('getRecord', false, err.message)
}

// 4. listRecords
try {
  const res = await agent.com.atproto.repo.listRecords({
    repo: did,
    collection: COLLECTION,
  })
  const found = res.data.records.some((r) => r.uri.endsWith(`/${RKEY}`))
  step(
    'listRecords',
    found,
    `${res.data.records.length} record(s) in ${COLLECTION}`,
  )
} catch (err) {
  step('listRecords', false, err.message)
}

// 5. deleteRecord
try {
  await agent.com.atproto.repo.deleteRecord({
    repo: did,
    collection: COLLECTION,
    rkey: RKEY,
  })
  step('deleteRecord', true, RKEY)
} catch (err) {
  step('deleteRecord', false, err.message)
}

if (failures > 0) {
  console.log(`SMOKE FAILED (${failures} failing step(s))`)
  process.exit(1)
}
console.log('SMOKE PASS')
