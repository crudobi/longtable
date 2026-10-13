// Seed the local ATProto testnet with the two Longtable proof accounts.
//
// Creates (or, if they already exist, logs into) on the local PDS:
//   author:   olga.test    / olga@test.local
//   attacker: mallory.test / mallory@test.local
// both with password "test-account-password", and writes their DIDs to
// /home/devbox/ops/longtable-atproto/accounts.json :
//   { author: { handle, password, did }, attacker: { handle, password, did } }
//
// The testnet is ephemeral — every restart of start.mjs mints brand-new
// DIDs — so this script must be re-run after each start. It is idempotent
// within a single testnet lifetime: re-running it logs in instead of
// failing on "handle already taken" and refreshes the DIDs in the file.
//
// @atproto/api is CommonJS, so it is loaded via createRequire.

import { createRequire } from 'node:module'
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

const require = createRequire(import.meta.url)
const { BskyAgent } = require('@atproto/api')

const PDS_URL = process.env.PDS_URL ?? 'http://localhost:2583'
const ACCOUNTS_FILE = process.env.ACCOUNTS_FILE ?? '/home/devbox/ops/longtable-atproto/accounts.json'
const PASSWORD = 'test-account-password'

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
    return res.data.did
  } catch (createErr) {
    // Already exists (in this testnet lifetime): log in and reuse its DID.
    try {
      const res = await agent.login({
        identifier: spec.handle,
        password: PASSWORD,
      })
      console.log(
        `[seed] ${spec.handle} already exists, logged in -> ${res.data.did} (create failed with: ${createErr.message})`,
      )
      return res.data.did
    } catch {
      // Neither create nor login worked: surface the original error.
      throw createErr
    }
  }
}

const accounts = {}
for (const spec of SPECS) {
  const did = await ensureAccount(spec)
  accounts[spec.key] = { handle: spec.handle, password: PASSWORD, did }
}

await mkdir(dirname(ACCOUNTS_FILE), { recursive: true })
await writeFile(ACCOUNTS_FILE, JSON.stringify(accounts, null, 2) + '\n')
console.log(`[seed] wrote ${ACCOUNTS_FILE}`)
console.log(JSON.stringify(accounts, null, 2))
