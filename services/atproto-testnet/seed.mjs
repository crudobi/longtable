// Seed the local ATProto testnet with the two Longtable proof accounts.
//
// Creates (or, if they already exist, logs into) on the local PDS:
//   author:   olga.test    / olga@test.local
//   attacker: mallory.test / mallory@test.local
// The password comes from LT_SEED_PASSWORD when set; otherwise a random
// one is generated per run and printed ONCE (see the end of this file).
// There is deliberately no default password: this script is also the
// documented way hub operators create their starter accounts, so a
// shipped constant would be a published credential for every hub.
// Writes handles/passwords/DIDs to the accounts file:
//   { author: { handle, password, did }, attacker: { handle, password, did } }
//
// The testnet is ephemeral — every restart of start.mjs mints brand-new
// DIDs — so this script must be re-run after each start. It is idempotent
// within a single testnet lifetime: re-running it logs in instead of
// failing on "handle already taken" and refreshes the DIDs in the file.
//
// @atproto/api is CommonJS, so it is loaded via createRequire.

import { createRequire } from 'node:module'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { randomBytes } from 'node:crypto'

const require = createRequire(import.meta.url)
const { BskyAgent } = require('@atproto/api')

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE ?? '/home/devbox/ops/longtable-atproto/accounts.json'
const GENERATED = !process.env.LT_SEED_PASSWORD
const PASSWORD = process.env.LT_SEED_PASSWORD ?? randomBytes(18).toString('base64url')

// Passwords from a previous seed (same testnet lifetime): re-running the
// seed must stay idempotent, so the login fallback also tries the stored
// password — a fresh random PASSWORD alone could not log back into
// accounts created minutes ago by an earlier run of this same script.
let stored = {}
try {
  stored = JSON.parse(await readFile(ACCOUNTS_FILE, 'utf8'))
} catch {
  /* first seed — no accounts file yet */
}

const SPECS = [
  { key: 'author', handle: 'olga.test', email: 'olga@test.local' },
  { key: 'attacker', handle: 'mallory.test', email: 'mallory@test.local' },
]

async function ensureAccount(spec) {
  const agent = new BskyAgent({ service: PDS_URL })
  try {
    const res = await agent.createAccount({
      handle: spec.handle,
      email: spec.email,
      password: PASSWORD,
    })
    console.log(`[seed] created ${spec.handle} -> ${res.data.did}`)
    return { did: res.data.did, password: PASSWORD }
  } catch (createErr) {
    // Already exists (in this testnet lifetime): log in and reuse its
    // DID. Try this run's password first, then the stored one.
    const candidates = [PASSWORD, stored[spec.key]?.password].filter(
      (v, i, a) => typeof v === 'string' && v && a.indexOf(v) === i,
    )
    for (const pw of candidates) {
      try {
        const res = await agent.login({ identifier: spec.handle, password: pw })
        console.log(
          `[seed] ${spec.handle} already exists, logged in -> ${res.data.did} (create failed with: ${createErr.message})`,
        )
        // Return the password that WORKED — the caller writes it back to
        // the accounts file. (Writing this run's fresh random here when
        // the stored password was the one that authenticated would poison
        // the file: the next run could then log in with neither.)
        return { did: res.data.did, password: pw }
      } catch {
        /* try the next candidate */
      }
    }
    // Neither create nor any login worked: surface the original error.
    throw createErr
  }
}

const accounts = {}
for (const spec of SPECS) {
  const { did, password } = await ensureAccount(spec)
  accounts[spec.key] = { handle: spec.handle, password, did }
}

await mkdir(dirname(ACCOUNTS_FILE), { recursive: true })
await writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2) + '\n')
console.log(`[seed] wrote ${ACCOUNTS_FILE}`)
for (const spec of SPECS) {
  console.log(`[seed] ${spec.key}: ${spec.handle} -> ${accounts[spec.key].did}`)
}
if (GENERATED) {
  console.log('[seed] ------------------------------------------------------------')
  console.log('[seed] Seed password(s) — shown once, store them now:')
  for (const spec of SPECS) {
    console.log(`[seed]   ${spec.handle}: ${accounts[spec.key].password}`)
  }
  console.log('[seed] They are also stored in the accounts file; treat that')
  console.log('[seed] file as a secret. Set LT_SEED_PASSWORD to choose your own.')
  console.log('[seed] ------------------------------------------------------------')
}
