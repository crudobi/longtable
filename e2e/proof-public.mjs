#!/usr/bin/env node
/**
 * Longtable Phase 3 oath proof — REAL app on emulator-5554 + host-side legs.
 *
 * Oath: "A public recipe is anyone's to find, nobody's to forge."
 *
 *   1. In the app: sign in to the local testnet PDS (hub-managed option),
 *      create "Proof Public Stew", flip it public via the UI.
 *   2. Poll the hub AppView search until the recipe appears — latency is
 *      measured and printed (oath: searchable within seconds). Search by
 *      name AND by ingredient list (AND semantics checked both ways).
 *   3. In-app discovery: find the recipe via Discover, author DID shown,
 *      save a copy into the local cookbook.
 *   4. INDEPENDENT verifier (scripts/verify-public, official @atproto libs
 *      only): repo signature, lexicon validity, pubkey binding, device
 *      signature — all must pass.
 *   5. Forge attempts: (a) Mallory's token writing into Olga's repo — the
 *      PDS must refuse; (b) Mallory publishes a mimic record under her OWN
 *      DID claiming Olga's device — the AppView must DROP it at ingest (no
 *      valid binding/device signature for it), never index it under any
 *      DID, and count it in stats.signatureRejected; the verifier must
 *      reject it as Olga's; (c) verifier forge selftest (attacker-key
 *      re-sign + content tamper) must reject both; (d) NEW (C2): a
 *      tampered record in the AUTHOR's own repo — altered content under
 *      the genuine device signature — must be dropped by the AppView at
 *      ingest (the repo-commit signature is the PDS's own and cannot
 *      catch this), counted, never searchable, 404 on /recipe/, while
 *      the genuine record stays indexed.
 *   4b. Response contract: /recipe/ + /search serve deviceDid,
 *      deviceSignature and deviceKey (bound device public key, standard
 *      base64 — byte-identical to the binding record's devicePublicKey);
 *      the values must match the recipe's OWN device binding record
 *      (per-device rkey, resolved from the verified repo CAR — H-N1:
 *      the client binds per device and never writes the legacy `self`
 *      record, so `self` names a stale device).
 *   6. Privacy audit: with recipes private / friends-only / public on the
 *      device, the verified repo dump must contain ONLY the public one (+
 *      the pubkey binding). Private and friends-only bytes never left.
 *   7. Flip public → private: the record must vanish from the PDS and from
 *      AppView search.
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB
const APK = process.env.APK || path.join(LT_ROOT, 'builds/longtable/longtable-debug.apk')
const ACTIVITY = 'kitchen.longtable.app.MainActivity'
const ACCOUNTS = JSON.parse(
  fs.readFileSync(process.env.ACCOUNTS_FILE ?? path.join(LT_ROOT, 'ops/longtable-atproto/accounts.json'), 'utf8'),
)
const AUTHOR = ACCOUNTS.author
const ATTACKER = ACCOUNTS.attacker
const PDS_HOST = 'http://localhost:2583'
const APPVIEW = 'http://localhost:3210'
const PDS_EMU = 'https://10.0.2.2:2584'
const APPVIEW_EMU = 'https://10.0.2.2:3211'
const VERIFIER = path.join(LT_REPO, 'scripts/verify-public/verify-public.mjs')

const STEW = 'Proof Public Stew'
const PIE = 'Proof Private Pie'
const FONDUE = 'Proof Friends Fondue'

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/* ---------------- host-side helpers ------------------------------------ */

async function xrpc(base, path, { method = 'GET', token, body } = {}) {
  const res = await fetch(`${base}/xrpc/${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    /* not json */
  }
  return { status: res.status, json }
}

async function createSession(handle, password) {
  const { status, json } = await xrpc(PDS_HOST, 'com.atproto.server.createSession', {
    method: 'POST',
    body: { identifier: handle, password },
  })
  if (status !== 200) throw new Error(`createSession ${handle}: HTTP ${status}`)
  return json
}

async function appviewSearch(params) {
  const qs = new URLSearchParams(params).toString()
  const res = await fetch(`${APPVIEW}/search?${qs}`)
  if (!res.ok) return []
  const { results } = await res.json()
  return results || []
}

async function appviewStats() {
  const res = await fetch(`${APPVIEW}/stats`)
  if (!res.ok) return null
  return res.json()
}

async function pollUntil(fn, timeout = 30000, interval = 250) {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return { value: v, elapsed: Date.now() - start }
    } catch {
      /* keep polling */
    }
    if (Date.now() - start > timeout) return { value: null, elapsed: Date.now() - start }
    await sleep(interval)
  }
}

function runVerifier(args) {
  try {
    const out = execFileSync('node', [VERIFIER, ...args], {
      encoding: 'utf8',
      timeout: 60000,
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

// Read-only CAR lookups via the independent verifier (H-N1): the recipe's
// own device binding, and the recipe record itself. These read the
// verified repo CAR — the same ground truth `verify` checks — and resolve
// the binding by deviceDid, at whatever rkey it lives at. Never the legacy
// `self` rkey: the client binds per device and never writes `self`, so
// `self` names a stale device. A lookup failure throws: fail closed,
// never compare against an undefined binding.
function runBinding(did, rkey) {
  const v = runVerifier(['binding', did, rkey])
  if (v.code !== 0) throw new Error(`verifier binding lookup failed for ${did}/${rkey}: ${v.out}`)
  return JSON.parse(v.out.trim())
}

function runRecord(did, rkey) {
  const v = runVerifier(['record', did, rkey])
  if (v.code !== 0) throw new Error(`verifier record lookup failed for ${did}/${rkey}: ${v.out}`)
  return JSON.parse(v.out.trim())
}

/* ---------------- app-side helpers -------------------------------------- */

async function makeSession(udid) {
  const driver = await remote({
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    logLevel: 'error',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': udid,
      'appium:appPackage': 'kitchen.longtable.app',
      'appium:appActivity': ACTIVITY,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:chromedriverAutodownload': true,
    },
  })
  await driver.execute('mobile: startActivity', {
    component: `kitchen.longtable.app/${ACTIVITY}`,
  })
  await sleep(1500)
  const contexts = await driver.getContexts()
  const webview = contexts.find((c) => c.startsWith('WEBVIEW'))
  if (!webview) throw new Error(`no webview context: ${contexts.join(',')}`)
  await driver.switchContext(webview)
  await (await driver.$('[data-testid="new-recipe"]')).waitForExist({ timeout: 30000 })
  return driver
}

async function evalJs(driver, script) {
  return driver.executeScript('return eval(arguments[0])', [script])
}

async function createRecipe(driver, title, ingredients, stepText) {
  await (await driver.$('[data-testid="new-recipe"]')).click()
  await (await driver.$('[data-testid="field-title"]')).waitForExist({ timeout: 20000 })
  await (await driver.$('[data-testid="field-title"]')).setValue(title)
  for (const ing of ingredients) {
    await (await driver.$('[data-testid="field-ingredient"]')).setValue(ing)
    await (await driver.$('[data-testid="add-ingredient"]')).click()
  }
  await (await driver.$('[data-testid="field-step"]')).setValue(stepText)
  await (await driver.$('[data-testid="add-step"]')).click()
  await (await driver.$('[data-testid="save-recipe"]')).click()
  await (await driver.$('[data-testid="recipe-title"]')).waitForExist({ timeout: 20000 })
}

async function backToList(driver) {
  const back = await driver.$('[data-testid="back-to-list"]')
  if (await back.isExisting()) {
    await back.click()
    await sleep(800)
  }
}

async function ensureList(driver) {
  for (let i = 0; i < 20; i++) {
    const modal = await driver.$('[data-testid="discover-panel"]')
    const modalOpen = await modal.isExisting()
    const list = await driver.$('[data-testid="recipe-list"]')
    if (!modalOpen && (await list.isExisting())) return
    const publicBack = await driver.$('[data-testid="public-back"]')
    if (await publicBack.isExisting()) {
      await publicBack.click()
      await sleep(700)
      continue
    }
    const closeDiscover = await driver.$('[data-testid="close-discover"]')
    if (await closeDiscover.isExisting()) {
      await closeDiscover.click()
      await sleep(700)
      continue
    }
    await backToList(driver)
    await sleep(500)
  }
}

async function openRecipeByTitle(driver, title) {
  await backToList(driver)
  const items = await driver.$$('[data-testid="recipe-item"]')
  for (const item of items) {
    const text = await item.getText()
    if (text.includes(title)) {
      await item.click()
      await (await driver.$('[data-testid="recipe-title"]')).waitForExist({ timeout: 20000 })
      return true
    }
  }
  return false
}

/* ---------------- main --------------------------------------------------- */

async function main() {
  console.log(`author=${AUTHOR.did} attacker=${ATTACKER.did}`)
  execFileSync(ADB, ['-s', 'emulator-5554', 'install', '-r', APK])
  execFileSync(ADB, ['-s', 'emulator-5554', 'shell', 'pm', 'clear', 'kitchen.longtable.app'])
  console.log('APK installed, app data cleared on emulator-5554')

  const A = await makeSession('emulator-5554')
  try {
    // ---- 1. Create the stew, sign in, publish via UI ---------------------
    await createRecipe(A, STEW, ['2 cups flour', '1 tsp smoked paprika'], 'Stew it low and slow.')
    step('app: recipe created', true)

    await (await A.$('[data-testid="open-publish-settings"]')).click()
    await (await A.$('[data-testid="field-pds-url"]')).waitForExist({ timeout: 20000 })
    await (await A.$('[data-testid="field-pds-url"]')).setValue(PDS_EMU)
    await (await A.$('[data-testid="field-handle"]')).setValue(AUTHOR.handle)
    await (await A.$('[data-testid="field-app-password"]')).setValue(AUTHOR.password)
    await (await A.$('[data-testid="atproto-signin"]')).click()
    const signedIn = await pollUntil(
      () => evalJs(A, '!!window.__ltSecrets.readSecret("longtable:atproto-session")'),
      30000,
      500,
    )
    step('app: signed in to hub PDS', !!signedIn.value)
    await (await A.$('[data-testid="close-publish-settings"]')).click()
    await sleep(600)

    // Going public asks for confirmation first (M-K); the harness
    // confirms on the user's behalf — same pattern as proof-friends'
    // unfriend leg.
    await evalJs(A, 'window.confirm = () => true')
    const t0 = Date.now()
    await (await A.$('[data-testid="visibility-public"]')).click()
    const found = await pollUntil(async () => {
      const rs = await appviewSearch({ q: STEW })
      return rs.find((r) => r.did === AUTHOR.did) || null
    }, 60000, 200)
    const latencyMs = Date.now() - t0
    step(
      'oath: public recipe searchable by name via AppView',
      !!found.value,
      found.value ? `search latency ${latencyMs} ms from visibility click` : 'not found in 60s',
    )

    const registryRaw = await evalJs(
      A,
      'localStorage.getItem("longtable:publications:v1") || "{}"',
    )
    const registry = JSON.parse(registryRaw)
    const stewId = Object.keys(registry)[0]
    step('app: publication registry holds the record', !!stewId, stewId ? `rkey=${stewId}` : '')

    // ---- 2. AppView search semantics --------------------------------------
    const byIngredients = await appviewSearch({ ingredients: 'flour,paprika' })
    step(
      'appview: search by ingredient list (flour+paprika) finds it',
      byIngredients.some((r) => r.did === AUTHOR.did && r.name === STEW),
    )
    const wrongIngredients = await appviewSearch({ ingredients: 'flour,quinoa' })
    step(
      'appview: ingredient AND semantics (flour+quinoa) excludes it',
      !wrongIngredients.some((r) => r.did === AUTHOR.did),
    )

    // ---- 3. In-app discovery ----------------------------------------------
    await backToList(A)
    await (await A.$('[data-testid="open-discover"]')).click()
    await (await A.$('[data-testid="field-appview-url"]')).waitForExist({ timeout: 20000 })
    await (await A.$('[data-testid="field-appview-url"]')).setValue(APPVIEW_EMU)
    await (await A.$('[data-testid="field-discover-q"]')).setValue(STEW)
    await (await A.$('[data-testid="discover-search"]')).click()
    await (await A.$('[data-testid="discover-result"]')).waitForExist({ timeout: 30000 })
    // Pick the AUTHOR's result explicitly: the AppView index persists
    // across proof runs, so a prior run's attacker mimic (same title)
    // can also match the search. Clicking the first result is a coin
    // flip — select by the author DID fragment shown on the card.
    const didFrag = AUTHOR.did.slice(8, 18)
    let resultEl = null
    for (const el of await A.$$('[data-testid="discover-result"]')) {
      if ((await el.getText()).includes(didFrag)) { resultEl = el; break }
    }
    if (!resultEl) throw new Error('discover results contain no card from the author DID')
    await resultEl.click()
    await (await A.$('[data-testid="public-recipe-view"]')).waitForExist({ timeout: 20000 })
    const authorShown = await (await A.$('[data-testid="public-author"]')).getText()
    step('discovery: public view shows author DID', authorShown.trim() === AUTHOR.did, authorShown.trim())
    await (await A.$('[data-testid="public-save-copy"]')).click()
    await sleep(1500)
    await ensureList(A)
    const itemsAfterCopy = await A.$$('[data-testid="recipe-item"]')
    let stewCount = 0
    for (const item of itemsAfterCopy) {
      if ((await item.getText()).includes(STEW)) stewCount++
    }
    step('discovery: save-a-copy landed in local cookbook', stewCount >= 2, `${stewCount} copies`)

    // ---- 4. Independent verifier ------------------------------------------
    const v = runVerifier(['verify', AUTHOR.did, stewId])
    console.log(v.out.trim())
    step('verifier: author record fully verifies (repo sig + lexicon + binding + device sig)', v.code === 0)

    // ---- 4b. Response contract: /recipe/ serves the signature fields ----
    // The reference binding is the recipe's OWN device binding, resolved
    // from the verified repo CAR (H-N1) — not the legacy `self` record,
    // which this client never writes and which names a stale device.
    const binding = runBinding(AUTHOR.did, stewId)
    const fullRes = await fetch(`${APPVIEW}/recipe/${encodeURIComponent(AUTHOR.did)}/${encodeURIComponent(stewId)}`)
    const full = await fullRes.json()
    step(
      'contract: /recipe/ serves deviceDid/deviceSignature/deviceKey',
      fullRes.status === 200 &&
        typeof full.deviceDid === 'string' &&
        typeof full.deviceSignature === 'string' &&
        typeof full.deviceKey === 'string',
      `HTTP ${fullRes.status}`,
    )
    step(
      'contract: deviceKey equals the binding record devicePublicKey',
      full.deviceKey === binding.devicePublicKey,
    )
    step(
      'contract: deviceDid equals the binding record deviceDid',
      full.deviceDid === binding.deviceDid,
    )
    // Match by rkey, not just by author DID: the index legitimately holds
    // genuine stews from several devices/runs (H-N1), each with its own
    // device fields — the first author hit is not necessarily this stew.
    const searchHit = (await appviewSearch({ q: STEW })).find((r) => r.did === AUTHOR.did && r.rkey === stewId)
    step(
      'contract: /search summary carries the same signature fields',
      !!searchHit &&
        searchHit.deviceDid === full.deviceDid &&
        searchHit.deviceSignature === full.deviceSignature &&
        searchHit.deviceKey === full.deviceKey,
    )

    // ---- 5. Forge attempts --------------------------------------------------
    // (a) Mallory's token, Olga's repo — the PDS itself must refuse.
    const mallorySession = await createSession(ATTACKER.handle, ATTACKER.password)
    const crossWrite = await xrpc(PDS_HOST, 'com.atproto.repo.putRecord', {
      method: 'POST',
      token: mallorySession.accessJwt,
      body: {
        repo: AUTHOR.did,
        collection: 'kitchen.longtable.recipe',
        rkey: 'forged-by-mallory',
        record: { $type: 'kitchen.longtable.recipe', name: 'Forged Stew' },
      },
    })
    step('forge: cross-account write into author repo refused by PDS', crossWrite.status >= 400, `HTTP ${crossWrite.status}`)

    // (b) Mallory's mimic: her own repo, Olga's device DID, garbage signature.
    // C2: the AppView verifies device signatures at ingest now. Mallory has
    // no pubkey binding for Olga's device (and no valid signature of her
    // own), so the mimic must NEVER be indexed — not merely attributed to
    // her. Capture stats first: the drop must show up as signatureRejected.
    // The mimic claims the genuine CURRENT device (H-N1: the binding
    // resolved for the fresh stew) — not the stale legacy `self` record.
    const statsBeforeMimic = await appviewStats()
    const authorDeviceDid = binding.deviceDid
    // Author rkeys before the mimic: the index legitimately holds genuine
    // stews from several devices/runs (H-N1), so the attribution check
    // below compares sets instead of assuming exactly one record.
    const authorBeforeMimic = (await appviewSearch({ q: STEW }))
      .filter((r) => r.did === AUTHOR.did)
      .map((r) => r.rkey)
      .sort()
    const mimic = await xrpc(PDS_HOST, 'com.atproto.repo.putRecord', {
      method: 'POST',
      token: mallorySession.accessJwt,
      body: {
        repo: ATTACKER.did,
        collection: 'kitchen.longtable.recipe',
        rkey: 'mimic-stew',
        record: {
          $type: 'kitchen.longtable.recipe',
          name: STEW,
          description: 'A mimic, published under the attacker DID.',
          ingredients: ['2 cups flour', '1 tsp smoked paprika'],
          instructions: ['Serve confusion.'],
          longtableId: 'mimic-stew',
          deviceDid: authorDeviceDid,
          deviceSignature: Buffer.from(new Uint8Array(64).fill(7)).toString('base64'),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    })
    step('forge setup: mimic published under attacker DID', mimic.status === 200, `HTTP ${mimic.status}`)
    const mimicRejected = await pollUntil(async () => {
      const st = await appviewStats()
      return st && (st.signatureRejected ?? 0) > (statsBeforeMimic?.signatureRejected ?? 0) ? st : null
    }, 30000, 500)
    step('forge: mimic counted as signature-rejected by the AppView', !!mimicRejected.value)
    const mimicSearch = await appviewSearch({ q: STEW })
    step('forge: mimic is NOT indexed under any DID', !mimicSearch.some((r) => r.did === ATTACKER.did))
    const mimicRecipe = await fetch(`${APPVIEW}/recipe/${encodeURIComponent(ATTACKER.did)}/mimic-stew`)
    step('forge: mimic 404s on /recipe/', mimicRecipe.status === 404)
    const afterMimic = await appviewSearch({ q: STEW })
    const authorEntries = afterMimic.filter((r) => r.did === AUTHOR.did)
    const authorRkeys = authorEntries.map((r) => r.rkey).sort()
    step(
      'forge: author attribution unchanged (genuine records intact, mimic added none)',
      authorEntries.some((r) => r.rkey === stewId) &&
        authorRkeys.length === authorBeforeMimic.length &&
        authorRkeys.every((rk, i) => rk === authorBeforeMimic[i]),
      `${authorEntries.length} author entr(ies)`,
    )
    const vMimic = runVerifier(['verify', ATTACKER.did, 'mimic-stew'])
    step('verifier: mimic record REJECTED (no valid binding/device signature)', vMimic.code !== 0)

    // (c) Verifier forge selftest on the genuine record.
    const vForge = runVerifier(['forge-selftest', AUTHOR.did, stewId])
    console.log(vForge.out.trim())
    step('verifier: re-sign + tamper forgeries both rejected', vForge.code === 0)

    // (d) Tampered record served through the AppView: the AUTHOR's own
    // session writes a record with altered content but the GENUINE device
    // signature. The PDS accepts it — the repo-commit signature is the
    // PDS's own and cannot catch this — so the AppView's device-signature
    // check at ingest is the only thing standing between the tamper and
    // search results.
    const authorSession = await createSession(AUTHOR.handle, AUTHOR.password)
    // Read the genuine record from the verified repo CAR — the same
    // snapshot the verifier just checked — not a live PDS read.
    const genuineRec = runRecord(AUTHOR.did, stewId)
    const statsBeforeTamper = await appviewStats()
    const tampered = await xrpc(PDS_HOST, 'com.atproto.repo.putRecord', {
      method: 'POST',
      token: authorSession.accessJwt,
      body: {
        repo: AUTHOR.did,
        collection: 'kitchen.longtable.recipe',
        rkey: 'tampered-stew',
        record: {
          ...genuineRec,
          ingredients: [...genuineRec.ingredients, '1 cup motor oil'],
        },
      },
    })
    step('forge setup: tampered record written to author repo (genuine signature)', tampered.status === 200, `HTTP ${tampered.status}`)
    const tamperRejected = await pollUntil(async () => {
      const st = await appviewStats()
      return st && (st.signatureRejected ?? 0) > (statsBeforeTamper?.signatureRejected ?? 0) ? st : null
    }, 30000, 500)
    step('appview: tampered record counted as signature-rejected', !!tamperRejected.value)
    const tamperSearch = await appviewSearch({ q: STEW })
    step('appview: tampered record NOT in search', !tamperSearch.some((r) => r.rkey === 'tampered-stew'))
    const tamperRecipe = await fetch(`${APPVIEW}/recipe/${encodeURIComponent(AUTHOR.did)}/tampered-stew`)
    step('appview: tampered record 404s on /recipe/', tamperRecipe.status === 404)
    const stillGenuine = await appviewSearch({ q: STEW })
    step(
      'appview: genuine stew still indexed after tamper rejection',
      stillGenuine.some((r) => r.did === AUTHOR.did && r.rkey === stewId),
    )

    // ---- 6. Privacy audit ----------------------------------------------------
    await createRecipe(A, PIE, ['1 pie crust', '3 apples'], 'Bake until golden.')
    await backToList(A)
    await openRecipeByTitle(A, PIE) // ensure created as private; nothing to flip
    await backToList(A)
    await createRecipe(A, FONDUE, ['1 wheel brie', '1 baguette'], 'Melt and dip.')
    // Flip Fondue to friends-only via the UI (tier flips immediately; the
    // share modal opens — dismiss it without picking anyone).
    await (await A.$('[data-testid="visibility-friends"]')).click()
    await sleep(1500)
    const shareModal = await A.$('[data-testid="friend-share-modal"]')
    if (await shareModal.isExisting()) {
      await (await A.$('[data-testid="close-friend-share"]')).click()
      await sleep(800)
    }
    await backToList(A)

    const audit = runVerifier(['audit', AUTHOR.did])
    console.log(audit.out.trim())
    const auditText = audit.out
    step(
      'privacy audit: public recipe IS in the repo',
      auditText.includes(`kitchen.longtable.recipe/${stewId}`),
    )
    step('privacy audit: pubkey binding present', auditText.includes(`kitchen.longtable.pubkey/${binding.rkey}`))
    step(
      'privacy audit: private recipe ABSENT from repo',
      !auditText.includes(PIE),
    )
    step(
      'privacy audit: friends-only recipe ABSENT from repo',
      !auditText.includes(FONDUE),
    )

    // ---- 7. Public → private removes the bytes --------------------------------
    const unpub = await evalJs(
      A,
      `window.__ltPublic.setVisibilityById(${JSON.stringify(stewId)}, 'private').then(() => 'done')`,
    )
    step('app: public→private via visibility handler', unpub === 'done')
    const goneFromPds = await pollUntil(async () => {
      const r = await xrpc(
        PDS_HOST,
        `com.atproto.repo.getRecord?repo=${encodeURIComponent(AUTHOR.did)}&collection=kitchen.longtable.recipe&rkey=${encodeURIComponent(stewId)}`,
      )
      return r.status === 400 || r.status === 404 ? true : null
    }, 30000, 500)
    step('unpublish: record gone from PDS', !!goneFromPds.value)
    const goneFromSearch = await pollUntil(async () => {
      const rs = await appviewSearch({ q: STEW })
      // This record is gone when no author entry carries ITS rkey — older
      // genuine stews from other devices/runs (H-N1) legitimately stay.
      return rs.every((r) => !(r.did === AUTHOR.did && r.rkey === stewId)) ? true : null
    }, 30000, 500)
    step('unpublish: record gone from AppView search', !!goneFromSearch.value)
  } finally {
    await A.deleteSession().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok).length
  console.log(`\nPROOF-PUBLIC: ${results.length - failed}/${results.length} PASS`)
  if (failed) process.exitCode = 1
}

main().catch((e) => {
  console.error('PROOF-PUBLIC ERROR', e)
  process.exit(1)
})
