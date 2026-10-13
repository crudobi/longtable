#!/usr/bin/env node
/**
 * proof-thirdparty.mjs — Phase 5 third-party client proof.
 *
 * The public half of the Phase 5 oath: a developer who's never met us can
 * build against the public protocol. This proof:
 *
 *   1. In the REAL app: sign in to the testnet PDS, create a recipe with a
 *      unique name ("Third-Party Gazpacho"), flip it public via the UI.
 *   2. Host-side: run examples/third-party-client/read-recipe.mjs — a
 *      client written from docs/public-protocol.md using ONLY official
 *      @atproto libraries + libsodium (zero app code) — in its documented
 *      search mode. It must find the recipe through the AppView and pass
 *      every signature verification (repo commit, binding, device sig).
 *   3. Negative leg: point the same client at the attacker's mimic record
 *      (created by proof-public; skipped with a note if absent). It must
 *      NOT verify — a client that rubber-stamps forgeries is worthless.
 *   4. Cleanup: flip the recipe back to private (the byte path deletes
 *      the PDS record), leaving Olga's repo as proof-public expects it.
 *
 * Run after proof-public (it seeds the accounts + the mimic). Exit 0 =
 * every leg passed.
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'

const ADB = '/home/devbox/tools/android-sdk/platform-tools/adb'
const APK = '/home/devbox/builds/longtable/longtable-debug.apk'
const ACTIVITY = 'kitchen.longtable.app.MainActivity'
const ACCOUNTS = JSON.parse(
  fs.readFileSync('/home/devbox/ops/longtable-atproto/accounts.json', 'utf8'),
)
const AUTHOR = ACCOUNTS.author
const ATTACKER = ACCOUNTS.attacker
const APPVIEW = 'http://localhost:3210'
const PDS_EMU = 'https://10.0.2.2:2584'
const CLIENT = '/home/devbox/code/longtable/examples/third-party-client/read-recipe.mjs'
const TITLE = 'Third-Party Gazpacho'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

async function pollUntil(fn, timeout = 45000, interval = 500) {
  const start = Date.now()
  for (;;) {
    try {
      const v = await fn()
      if (v) return v
    } catch { /* keep polling */ }
    if (Date.now() - start > timeout) return null
    await sleep(interval)
  }
}

function runClient(args, env = {}) {
  try {
    const out = execFileSync('node', [CLIENT, ...args], {
      encoding: 'utf8',
      timeout: 90000,
      env: {
        ...process.env,
        APPVIEW_URL: APPVIEW,
        PLC_URL: 'http://localhost:2582',
        ...env,
      },
    })
    return { code: 0, out }
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ''}${e.stderr || ''}` }
  }
}

async function main() {
  execFileSync(ADB, ['-s', 'emulator-5554', 'install', '-r', APK])
  execFileSync(ADB, ['-s', 'emulator-5554', 'shell', 'pm', 'clear', 'kitchen.longtable.app'])
  console.log('APK installed, app data cleared on emulator-5554')

  const driver = await remote({
    hostname: '127.0.0.1', port: 4723, path: '/', logLevel: 'error',
    capabilities: {
      platformName: 'Android',
      'appium:automationName': 'UiAutomator2',
      'appium:udid': 'emulator-5554',
      'appium:appPackage': 'kitchen.longtable.app',
      'appium:appActivity': ACTIVITY,
      'appium:noReset': true,
      'appium:autoLaunch': false,
      'appium:chromedriverAutodownload': true,
    },
  })
  try {
    await driver.execute('mobile: startActivity', {
      component: `kitchen.longtable.app/${ACTIVITY}`,
    })
    await sleep(1500)
    const contexts = await driver.getContexts()
    const webview = contexts.find((c) => c.startsWith('WEBVIEW'))
    if (!webview) throw new Error(`no webview context: ${contexts.join(',')}`)
    await driver.switchContext(webview)
    const $ = (sel) => driver.$(sel)
    const evalJs = (script) => driver.executeScript('return eval(arguments[0])', [script])

    // Create the recipe (detail view after save).
    await (await $('[data-testid="new-recipe"]')).waitForExist({ timeout: 30000 })
    await (await $('[data-testid="new-recipe"]')).click()
    await (await $('[data-testid="field-title"]')).waitForExist({ timeout: 20000 })
    await (await $('[data-testid="field-title"]')).setValue(TITLE)
    for (const ing of ['4 tomatoes', '1 cucumber', '1 red onion']) {
      await (await $('[data-testid="field-ingredient"]')).setValue(ing)
      await (await $('[data-testid="add-ingredient"]')).click()
    }
    await (await $('[data-testid="field-step"]')).setValue('Blend half, chop half, chill.')
    await (await $('[data-testid="add-step"]')).click()
    await (await $('[data-testid="save-recipe"]')).click()
    await (await $('[data-testid="recipe-title"]')).waitForExist({ timeout: 20000 })
    step('app: recipe created', true, TITLE)

    // Flip public: with no session the app opens publishing settings.
    await (await $('[data-testid="visibility-public"]')).click()
    await (await $('[data-testid="field-pds-url"]')).waitForExist({ timeout: 20000 })
    await (await $('[data-testid="field-pds-url"]')).setValue(PDS_EMU)
    await (await $('[data-testid="field-handle"]')).setValue(AUTHOR.handle)
    await (await $('[data-testid="field-app-password"]')).setValue(AUTHOR.password)
    await (await $('[data-testid="atproto-signin"]')).click()
    const status = await pollUntil(async () => {
      const el = await $('[data-testid="atproto-session-status"]')
      if (!(await el.isExisting())) return null
      const t = await el.getText()
      return t.includes(AUTHOR.handle) ? t : null
    }, 30000)
    step('app: signed in to the testnet PDS', !!status, AUTHOR.handle)
    await (await $('[data-testid="close-publish-settings"]')).click()
    await sleep(800)

    // Publish for real this time.
    await (await $('[data-testid="visibility-public"]')).click()
    const found = await pollUntil(async () => {
      const res = await fetch(`${APPVIEW}/author/${encodeURIComponent(AUTHOR.did)}`)
      if (!res.ok) return null
      const data = await res.json()
      const hit = (data.results || []).find((r) => r.name === TITLE)
      return hit || null
    }, 45000)
    step('appview: published recipe indexed under the author', !!found,
      found ? `rkey ${found.rkey}` : 'not indexed in 45s')
    if (!found) return
    const rkey = found.rkey

    // The third-party client, in its documented search mode.
    const good = runClient(['Gazpacho'])
    const goodPass = good.code === 0 && good.out.includes('RESULT: ALL PASS')
    step('third-party client: search → fetch → verify ALL PASS', goodPass,
      goodPass ? 'repo sig + binding + device sig verified' : `exit ${good.code}`)
    if (!goodPass) console.log(good.out)

    // Negative leg: the attacker's mimic must NOT verify.
    const mimicRes = await fetch(`${APPVIEW}/author/${encodeURIComponent(ATTACKER.did)}`)
    const mimicData = mimicRes.ok ? await mimicRes.json() : { results: [] }
    const mimic = (mimicData.results || [])[0]
    if (mimic) {
      const bad = runClient(['--did', ATTACKER.did, '--rkey', mimic.rkey])
      const rejected = bad.code !== 0 && !bad.out.includes('RESULT: ALL PASS')
      step('third-party client: attacker mimic REJECTED', rejected,
        rejected ? `exit ${bad.code}` : 'client accepted a forgery!')
      if (!rejected) console.log(bad.out)
    } else {
      console.log('NOTE: no attacker record indexed — negative leg skipped (run proof-public first)')
    }

    // Cleanup: flip back to private via the app's own byte path.
    await evalJs(
      `window.__ltPublic.setVisibilityById(${JSON.stringify(rkey)}, 'private').then(() => 'done')`,
    )
    const gone = await pollUntil(async () => {
      const res = await fetch(`${APPVIEW}/author/${encodeURIComponent(AUTHOR.did)}`)
      if (!res.ok) return null
      const data = await res.json()
      return (data.results || []).every((r) => r.name !== TITLE) ? true : null
    }, 30000)
    step('cleanup: recipe unpublished (record deleted)', !!gone)
  } finally {
    try { await driver.deleteSession() } catch { /* ignore */ }
  }
}

main().catch((e) => {
  console.error(`ERROR: ${String(e?.message ?? e).split('\n')[0]}`)
  process.exit(1)
})
