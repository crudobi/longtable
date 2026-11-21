#!/usr/bin/env node
/**
 * Longtable E3 manual-SDP proof — REAL app, two emulators.
 *
 * Oath: "Two people pair as friends with no hub in the path."
 *
 *   A (emulator-5554, "Olga") creates a manual offer in the Friends
 *   panel; the harness carries the offer blob to B (emulator-5556,
 *   "Fay"), which pastes it and creates the answer; the harness
 *   carries the answer back to A, which completes the pairing.
 *   Both sides must then list each other as friends with the same
 *   DID-bound channelTag.
 *
 * The pairing runs over a direct RTCPeerConnection data channel: the
 * manual flow never opens a y-webrtc provider and never contacts a
 * signaling server. (ICE still uses the configured hubs' STUN/TURN
 * for NAT traversal — the fallback removes signaling, not
 * traversal.) The blobs themselves are never logged: they carry the
 * pair secret, exactly like the invite code.
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'

const APPIUM = 'http://127.0.0.1:4723'
const ACTIVITY = 'kitchen.longtable.app.MainActivity'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

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
  if (!webview) throw new Error(`no webview context on ${udid}: ${contexts.join(',')}`)
  await driver.switchContext(webview)
  const el = await driver.$('[data-testid="new-recipe"]')
  await el.waitForExist({ timeout: 30000 })
  return driver
}

async function evalJs(driver, script) {
  const result = await driver.executeScript('return eval(arguments[0])', [script])
  return result
}

async function waitFor(driver, fn, timeout = 90000, interval = 2000) {
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

async function openFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  if (await panel.isExisting()) return
  // friends-open lives on the list view; navigate there if needed. DOM
  // clicks with effect verification: coordinate clicks in this emulator
  // environment are intermittently swallowed, and an unverified open
  // leaves the proof polling a panel that never mounted.
  for (let i = 0; i < 20; i++) {
    const onList = await evalJs(driver, '!!document.querySelector(\'[data-testid="friends-open"]\')')
    if (onList) {
      await evalJs(driver, 'document.querySelector(\'[data-testid="friends-open"]\').click()')
    } else {
      await evalJs(driver, 'document.querySelector(\'[data-testid="back-to-list"]\')?.click()')
    }
    await sleep(900)
    if (await panel.isExisting()) return
  }
  await panel.waitForExist({ timeout: 20000 })
}

async function closeFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  // Verified DOM close: a swallowed coordinate click here once left the
  // panel mounted with pairing-time state for an entire proof run.
  for (let i = 0; i < 10 && (await panel.isExisting()); i++) {
    await evalJs(driver, 'document.querySelector(\'[data-testid="close-friends"]\')?.click()')
    await sleep(700)
  }
}

async function setName(driver, name) {
  const input = await driver.$('[data-testid="friend-name"]')
  await input.setValue(name)
  await sleep(300)
}

/**
 * Read a textarea's live value. NOTE: chromedriver getValue() returns
 * '' for these controlled textareas; read the DOM value property
 * directly (same workaround as proof-friends' createInvite).
 */
async function readTextarea(driver, testid, timeout = 30000) {
  return waitFor(
    driver,
    async () => {
      const v = await evalJs(driver,
        `document.querySelector('[data-testid="${testid}"]')?.value ?? ""`)
      return v ? String(v) : null
    },
    timeout,
    500,
  )
}

/**
 * Set a textarea's value the way React observes it: the native
 * setter + a bubbled input event. Blobs are KB-sized SDP; setValue
 * key-by-key is slow and flaky at that size.
 */
async function setTextarea(driver, testid, value) {
  await evalJs(driver, `(() => {
    const el = document.querySelector('[data-testid="${testid}"]')
    if (!el) return false
    const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set
    setter.call(el, ${JSON.stringify(value)})
    el.dispatchEvent(new Event('input', { bubbles: true }))
    return true
  })()`)
  await sleep(300)
}

async function main() {
  // Clean slate on both devices (app data only; CA store untouched).
  for (const serial of ['emulator-5554', 'emulator-5556']) {
    execFileSync(ADB, ['-s', serial, 'shell', 'pm', 'clear', 'kitchen.longtable.app'])
  }
  console.log('app data cleared on 5554/5556')

  const A = await makeSession('emulator-5554')
  const B = await makeSession('emulator-5556')
  console.log('sessions up: A=5554 B=5556')

  try {
    // ---- A creates the manual offer ---------------------------------
    await openFriends(A)
    await setName(A, 'Olga')
    await (await A.$('[data-testid="manual-offer-create"]')).click()
    const offer = await readTextarea(A, 'manual-offer-text')
    step('manual: offer blob created', !!offer)
    if (!offer) throw new Error('offer blob never populated')
    const offerJson = JSON.parse(Buffer.from(offer, 'base64url').toString('utf8'))
    const aDid = await evalJs(A, 'window.__ltFriends.myDid()')
    step(
      'manual: offer is a v1 manual-offer carrying an invite for A',
      offerJson.kind === 'manual-offer' &&
        offerJson.v === 1 &&
        offerJson.invite.did === aDid &&
        typeof offerJson.sdp === 'string' &&
        offerJson.sdp.startsWith('v='),
      `A=${String(aDid).slice(0, 20)}…`,
    )

    // ---- B answers the offer ----------------------------------------
    await openFriends(B)
    await setName(B, 'Fay')
    await setTextarea(B, 'manual-offer-input', offer)
    await (await B.$('[data-testid="manual-answer-create"]')).click()
    const answer = await readTextarea(B, 'manual-answer-text')
    step('manual: answer blob created', !!answer)
    if (!answer) throw new Error('answer blob never populated')
    const answerJson = JSON.parse(Buffer.from(answer, 'base64url').toString('utf8'))
    step(
      'manual: answer is a v1 manual-answer',
      answerJson.kind === 'manual-answer' &&
        answerJson.v === 1 &&
        typeof answerJson.sdp === 'string' &&
        answerJson.sdp.startsWith('v='),
    )

    // ---- A completes the pairing ------------------------------------
    await setTextarea(A, 'manual-answer-input', answer)
    await (await A.$('[data-testid="manual-answer-complete"]')).click()
    const aFriends = await waitFor(
      A,
      async () => (await A.$$('[data-testid="friend-item"]')).length >= 1,
      120000,
    )
    const bFriends = await waitFor(
      B,
      async () => (await B.$$('[data-testid="friend-item"]')).length >= 1,
      120000,
    )
    step('manual: both sides list the friend', !!aFriends && !!bFriends)
    if (!aFriends || !bFriends) {
      const errA = await evalJs(A, 'document.querySelector(\'[data-testid="friend-error"]\')?.textContent ?? ""')
      const errB = await evalJs(B, 'document.querySelector(\'[data-testid="friend-error"]\')?.textContent ?? ""')
      throw new Error(`pairing did not complete; A error=${errA} B error=${errB}`)
    }

    const bDid = await evalJs(B, 'window.__ltFriends.myDid()')
    const aRec = await evalJs(A, `window.__ltFriends.friends().then(fs => fs.find(f => f.did === ${JSON.stringify(bDid)}))`)
    const bRec = await evalJs(B, `window.__ltFriends.friends().then(fs => fs.find(f => f.did === ${JSON.stringify(aDid)}))`)
    step('manual: mutual DID records verified', !!aRec && !!bRec, `A=${String(aDid).slice(0, 20)}… B=${String(bDid).slice(0, 20)}…`)
    step(
      'manual: channel bound to both DIDs (equal channelTag)',
      !!aRec?.channelTag && aRec.channelTag === bRec.channelTag,
    )
    await closeFriends(A)
    await closeFriends(B)
  } finally {
    await A.deleteSession().catch(() => {})
    await B.deleteSession().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== proof-manual-sdp: ${results.length - failed.length}/${results.length} steps passed ===`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('proof-manual-sdp error:', e)
  process.exit(1)
})
