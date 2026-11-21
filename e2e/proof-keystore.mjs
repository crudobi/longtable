#!/usr/bin/env node
/**
 * Longtable Wave 3 keystore proof — REAL app, one emulator.
 *
 * Proves the H1 fix end to end on the fleet emulator:
 *
 *   Phase A (fresh install, new build):
 *     - the app launches, creates its identity, and works;
 *     - NONE of the seven secret keys is present in localStorage;
 *     - the identity secret IS present in the Android Keystore
 *       (via the SecureStore plugin), the store reports migrated,
 *       and the DID is stable across a force-stop + relaunch.
 *   Phase B (upgrade migration, old build -> new build):
 *     - the old build (pre-Keystore) creates its identity in
 *       localStorage and mints a loopback token through the real UI;
 *       a hub registry is seeded (synthetic values);
 *     - after installing the new build over it (data kept), the
 *       same DID comes back, every secret key is gone from
 *       localStorage, the moved values are byte-identical in the
 *       Keystore (compared by SHA-256 digest — values are never
 *       printed), and the app still works.
 *
 * Secrets are never printed: this script reports presence booleans,
 * digests, and the (public) DID only.
 *
 * Env:
 *   APK      new-build APK under test (required)
 *   OLD_APK  pre-Keystore APK (default: the published debug APK)
 *   ADB      adb path (default: <LT_ROOT>/tools/android-sdk/...)
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import sodium from 'libsodium-wrappers'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB =
  process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB
const APK = process.env.APK
if (!APK) {
  console.error('APK env is required (new-build APK under test)')
  process.exit(2)
}
const OLD_APK =
  process.env.OLD_APK ?? path.join(LT_ROOT, 'builds/longtable/longtable-debug.apk')
const PKG = 'kitchen.longtable.app'
const SERIAL = 'emulator-5554'
const ACTIVITY = 'kitchen.longtable.app.MainActivity'

const SECRET_KEYS = [
  'longtable:identity-secret',
  'longtable:key-vault',
  'longtable:friends',
  'longtable:atproto-session',
  'longtable:localapi',
  'longtable:hubs:v1',
  'longtable:shares',
]
const MIGRATION_MARKER = 'longtable:secrets-migrated-v1'

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sha256 = (s) => createHash('sha256').update(s, 'utf8').digest('hex')
const adb = (...args) => execFileSync(ADB, ['-s', SERIAL, ...args], { encoding: 'utf8' })

// base58btc (same alphabet as src/identity/codec.ts) — derives the
// did:key DID from a raw identity secret, so the migration phase can
// pin the old build's DID without debug hooks (the published debug
// APK is a hooks-OFF build).
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'
function base58btcEncode(bytes) {
  let n = 0n
  for (const b of bytes) n = (n << 8n) | BigInt(b)
  let out = ''
  while (n > 0n) {
    out = B58[Number(n % 58n)] + out
    n /= 58n
  }
  for (const b of bytes) {
    if (b !== 0) break
    out = '1' + out
  }
  return out || '1'
}
async function didFromSecretB64(b64) {
  await sodium.ready
  const secret = Buffer.from(b64, 'base64')
  if (secret.length !== 64) throw new Error(`bad secret length ${secret.length}`)
  const pub = secret.subarray(32, 64)
  const payload = Buffer.concat([Buffer.from([0xed, 0x01]), pub])
  return 'did:key:z' + base58btcEncode(payload)
}

let driver
async function newSession() {
  if (driver) {
    try {
      await driver.deleteSession()
    } catch {
      /* already gone */
    }
  }
  driver = await remote({
    protocol: 'http',
    hostname: '127.0.0.1',
    port: 4723,
    path: '/',
    logLevel: 'error',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': SERIAL,
      'appium:appPackage': PKG,
      'appium:appActivity': ACTIVITY,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:chromedriverAutodownload': true,
      'appium:newCommandTimeout': 180,
    },
  })
  await driver.execute('mobile: startActivity', { component: `${PKG}/${ACTIVITY}` })
  await sleep(1500)
  const contexts = await driver.getContexts()
  const webview = contexts.find((c) => String(c).toLowerCase().startsWith('webview'))
  if (!webview) throw new Error(`no webview context: ${contexts.join(',')}`)
  await driver.switchContext(webview)
  const el = await driver.$('[data-testid="new-recipe"]')
  await el.waitForExist({ timeout: 60000 })
}

async function evalJs(script) {
  return driver.executeScript('return eval(arguments[0])', [script])
}

async function waitFor(fn, timeout = 90000, interval = 2000) {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch {
      /* keep polling */
    }
    if (Date.now() - start > timeout) return null
    await sleep(interval)
  }
}

async function localStoragePresence() {
  const raw = await evalJs(
    `JSON.stringify(Object.fromEntries(${JSON.stringify(SECRET_KEYS)}.map(k => [k, localStorage.getItem(k) !== null])))`,
  )
  return JSON.parse(String(raw))
}

async function flushSecrets() {
  await evalJs(`window.__ltSecrets ? window.__ltSecrets.flush() : Promise.resolve()`)
}

async function createRecipe(title) {
  await (await driver.$('[data-testid="new-recipe"]')).click()
  await (await driver.$('[data-testid="field-title"]')).setValue(title)
  await (await driver.$('[data-testid="save-recipe"]')).click()
  const detail = await driver.$('[data-testid="recipe-detail"]')
  await detail.waitForExist({ timeout: 20000 })
  const t = await (await driver.$('[data-testid="recipe-title"]')).getText()
  if (t !== title) throw new Error(`detail title "${t}" != "${title}"`)
  await (await driver.$('//button[contains(., "Recipes")]')).click()
  await (await driver.$('[data-testid="recipe-list"]')).waitForExist({ timeout: 20000 })
}

async function relaunch() {
  await flushSecrets()
  adb('shell', 'am', 'force-stop', PKG)
  await newSession()
}

async function main() {
  // ---- Phase A: fresh install of the new build -----------------------
  try {
    adb('uninstall', PKG)
  } catch {
    /* not installed */
  }
  adb('install', APK)
  await newSession()

  const didA = await waitFor(async () => {
    try {
      const d = await evalJs(`window.__ltFriends ? window.__ltFriends.myDid() : null`)
      return typeof d === 'string' && d.startsWith('did:key:z') ? d : null
    } catch {
      return null
    }
  })
  step('fresh: identity created (DID via debug hook)', !!didA, didA ? `${didA.slice(0, 20)}…` : '')

  const hooks = await evalJs(`typeof window.__ltSecrets !== 'undefined'`)
  step('fresh: __ltSecrets debug hook installed', hooks === true)

  const presentA = await localStoragePresence()
  const anyInLocalStorageA = SECRET_KEYS.some((k) => presentA[k])
  step(
    'fresh: no secret key in localStorage',
    !anyInLocalStorageA,
    `present=${JSON.stringify(presentA)}`,
  )

  const available = await evalJs(`window.__ltSecrets.available()`)
  step('fresh: SecureStore available (native Keystore)', available === true)

  const idInStore = await evalJs(
    `window.__ltSecrets.readSecureStore('longtable:identity-secret').then(v => v !== null)`,
  )
  step('fresh: identity secret present in Keystore', idInStore === true)

  const statusA = JSON.parse(
    String(await evalJs(`window.__ltSecrets.status().then(s => JSON.stringify(s))`)),
  )
  step(
    'fresh: status migrated, no persist error',
    statusA.migrated === true && statusA.lastPersistError === null,
    `migrated=${statusA.migrated} pendingWrites=${statusA.pendingWrites}`,
  )

  await createRecipe('Keystore Soup')
  step('fresh: recipe created (app works)', true)
  await relaunch()
  const didA2 = await waitFor(async () => {
    try {
      return await evalJs(`window.__ltFriends.myDid()`)
    } catch {
      return null
    }
  })
  step('fresh: DID stable across force-stop + relaunch', didA2 === didA)
  const bodyA = await (await driver.$('body')).getText()
  step('fresh: recipe persists across restart', bodyA.includes('Keystore Soup'))
  const presentA2 = await localStoragePresence()
  step(
    'fresh: still no secret key in localStorage after restart',
    !SECRET_KEYS.some((k) => presentA2[k]),
    `present=${JSON.stringify(presentA2)}`,
  )

  // ---- Phase B: upgrade migration, old build -> new build ------------
  // The new build has a higher versionCode (git-count based), so the
  // old APK cannot install over it (downgrade). Uninstall first.
  try {
    await driver.deleteSession()
  } catch {
    /* ignore */
  }
  driver = null
  adb('uninstall', PKG)
  adb('install', OLD_APK)
  adb('shell', 'pm', 'clear', PKG)
  await newSession()

  // Old build: identity lands in localStorage (no Keystore yet).
  const oldSecret = await waitFor(async () => {
    try {
      const v = await evalJs(`localStorage.getItem('longtable:identity-secret')`)
      return typeof v === 'string' && v.length > 0 ? v : null
    } catch {
      return null
    }
  })
  step('migrate: old build stored identity in localStorage', !!oldSecret)
  const didOld = oldSecret ? await didFromSecretB64(String(oldSecret)) : null
  step('migrate: old DID derived from old secret', !!didOld, didOld ? `${didOld.slice(0, 20)}…` : '')

  // Old build, real UI write: enable the loopback API (mints a token).
  await (await driver.$('[data-testid="open-developer"]')).click()
  await (await driver.$('[data-testid="developer-modal"]')).waitForExist({ timeout: 20000 })
  await evalJs(`document.querySelector('[data-testid="localapi-toggle"]').click()`)
  const tokenOk = await waitFor(async () => {
    try {
      const t = await (await driver.$('[data-testid="localapi-token"]')).getText()
      return /^[0-9a-f]{64}$/.test(t.trim()) ? true : null
    } catch {
      return null
    }
  })
  step('migrate: old build minted a loopback token via UI', tokenOk === true)
  await (await driver.$('[data-testid="close-developer"]')).click()

  // Old build, seeded hub registry (synthetic values — stands in for an
  // existing install's hub list; the migration must move it as a unit).
  await evalJs(
    `localStorage.setItem('longtable:hubs:v1', JSON.stringify({hubs:[{id:'hub-test',name:'Test hub',signalingUrl:'wss://10.0.2.2:4445',turnUrl:'turn:10.0.2.2:3478',turnUsername:'tester',turnCredential:'synthetic-test-credential',appviewUrl:'http://localhost:3210',pdsUrl:'http://localhost:2583'}],activeId:'hub-test'}))`,
  )

  // Digest the pre-upgrade values (digests + lengths only — values never printed).
  const preDigests = {}
  const preLens = {}
  for (const key of ['longtable:identity-secret', 'longtable:localapi', 'longtable:hubs:v1']) {
    const v = await evalJs(`localStorage.getItem(${JSON.stringify(key)})`)
    if (typeof v !== 'string' || !v) throw new Error(`pre-upgrade value missing for ${key}`)
    preDigests[key] = sha256(String(v))
    preLens[key] = String(v).length
  }
  step('migrate: pre-upgrade digests captured (3 keys)', Object.keys(preDigests).length === 3)

  // WebView localStorage flush window: the WebView commits localStorage
  // to disk asynchronously after a write, and `am force-stop` SIGKILLs
  // the process — values written seconds before the kill can be lost
  // before the commit lands (identity-secret survived every run because
  // it was written minutes earlier at old-build launch; the token and
  // the seeded hub registry, written seconds before the kill, did not).
  // A real upgrade happens long after the last write, so wait 15s to
  // let the commit land before killing the app.
  await sleep(15000)
  // Upgrade over the old data, then launch the new build.
  await flushSecrets().catch(() => undefined)
  adb('shell', 'am', 'force-stop', PKG)
  adb('install', '-r', APK)
  await newSession()

  const didNew = await waitFor(async () => {
    try {
      const d = await evalJs(`window.__ltFriends ? window.__ltFriends.myDid() : null`)
      return typeof d === 'string' && d.startsWith('did:key:z') ? d : null
    } catch {
      return null
    }
  })
  step('migrate: same DID after upgrade', didNew === didOld, didNew ? `${didNew.slice(0, 20)}…` : 'no DID')

  const presentB = await localStoragePresence()
  step(
    'migrate: no secret key left in localStorage',
    !SECRET_KEYS.some((k) => presentB[k]),
    `present=${JSON.stringify(presentB)}`,
  )
  const marker = await evalJs(`localStorage.getItem(${JSON.stringify(MIGRATION_MARKER)})`)
  step('migrate: migration marker set', marker === '1')

  let movedOk = true
  const perKey = {}
  for (const key of Object.keys(preDigests)) {
    const v = await evalJs(
      `window.__ltSecrets.readSecureStore(${JSON.stringify(key)}).then(x => x)`,
    )
    // Lengths only: a mismatch's shape (same length = same shape, new
    // content; different length = rewritten) diagnoses the cause
    // without ever printing a value.
    const postLen = typeof v === 'string' ? String(v).length : -1
    const match = typeof v === 'string' && sha256(String(v)) === preDigests[key]
    perKey[key] = { match, preLen: preLens[key], postLen }
    if (!match) movedOk = false
  }
  step(
    'migrate: all 3 moved values byte-identical in Keystore (digest match)',
    movedOk,
    `perKey=${JSON.stringify(perKey)}`,
  )

  const reportB = await evalJs(
    `window.__ltSecrets.initReport() ? JSON.stringify(window.__ltSecrets.initReport()) : 'null'`,
  )
  step(
    'migrate: init report outcomes',
    true,
    `report=${String(reportB)}`,
  )
  const statusB = JSON.parse(
    String(await evalJs(`window.__ltSecrets.status().then(s => JSON.stringify(s))`)),
  )
  step(
    'migrate: status migrated, no persist error',
    statusB.migrated === true && statusB.lastPersistError === null,
    `migrated=${statusB.migrated} pendingWrites=${statusB.pendingWrites}`,
  )

  await createRecipe('Migrated Stew')
  step('migrate: app works after upgrade (recipe created)', true)
  await relaunch()
  const didB2 = await waitFor(async () => {
    try {
      return await evalJs(`window.__ltFriends.myDid()`)
    } catch {
      return null
    }
  })
  step('migrate: DID still stable after post-upgrade restart', didB2 === didOld)
  const bodyB = await (await driver.$('body')).getText()
  step('migrate: post-upgrade recipe persists across restart', bodyB.includes('Migrated Stew'))
}

try {
  await main()
} catch (e) {
  results.push({ name: 'harness (unexpected throw)', ok: false })
  console.log(`FAIL  harness (unexpected throw) — ${String((e && e.message) || e).split('\n')[0]}`)
} finally {
  if (driver) {
    try {
      await driver.deleteSession()
    } catch {
      /* ignore */
    }
  }
}
const failed = results.filter((r) => !r.ok)
console.log(`\n==== proof-keystore: ${results.length - failed.length}/${results.length} steps passed ====`)
if (failed.length) {
  console.log('FAILED STEPS:')
  for (const f of failed) console.log(`  - ${f.name}`)
  process.exit(1)
}
