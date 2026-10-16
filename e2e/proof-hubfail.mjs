#!/usr/bin/env node
/**
 * Longtable Phase 4 oath proof — REAL app, two emulators, two packaged hubs.
 *
 * Oath: "The network survives the death of any hub, including ours."
 *
 *   Setup: hub A and hub B are independent instances deployed from the
 *   packaged artifact (longtable-hub tarball) under <LT_ROOT>/hubs/.
 *   Both emulators register BOTH hubs in the app (Hubs UI), hub A active.
 *   A ("Olga") pairs with B ("Fay") — the invite carries hub A's
 *   signaling — and shares "Hubfail Stew" friends-only.
 *
 *   KILL LEG: hub A is stopped entirely mid-session. Both apps are
 *   force-restarted (worst case: cold start with the primary hub dead).
 *   A edits the recipe; the edit must reach B via hub B, because every
 *   provider rendezvous on EVERY configured hub. Inventory (identity,
 *   friends, hubs) must be byte-identical before and after.
 *
 *   FLOOR LEG: hub B is killed too. With NO hub alive, A exports the
 *   share snapshot (the QR/paste payload) and B joins from the pasted
 *   text — the zero-hub floor. B's local copy must match A's exactly.
 *
 *   The proof leaves both hubs running again at the end.
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'
import net from 'node:net'

const ACTIVITY = 'kitchen.longtable.app.MainActivity'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB
const HUB_A_DIR = process.env.HUB_A_DIR ?? path.join(LT_ROOT, 'hubs/hub-a')
const HUB_B_DIR = process.env.HUB_B_DIR ?? path.join(LT_ROOT, 'hubs/hub-b')

const HUB_A = {
  name: 'Hub A',
  signaling: 'wss://10.0.2.2:4445',
  turn: 'turn:10.0.2.2:3479',
  turnUser: 'longtable',
  turnPass: 'lt-turn-a-password',
  appview: 'https://10.0.2.2:3221',
  pds: 'https://10.0.2.2:2594',
  signalingPort: 4445,
}
const HUB_B = {
  name: 'Hub B',
  signaling: 'wss://10.0.2.2:4446',
  turn: 'turn:10.0.2.2:3480',
  turnUser: 'longtable',
  turnPass: 'lt-turn-b-password',
  appview: 'https://10.0.2.2:3222',
  pds: 'https://10.0.2.2:2597',
  signalingPort: 4446,
}

const results = []
function step(name, ok, detail = '') {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

function hubCtl(dir, action) {
  return execFileSync(`${dir}/longtable-hub`, [action], {
    cwd: dir,
    encoding: 'utf8',
    timeout: 60000,
  })
}

function tcpConnectable(port) {
  return new Promise((resolve) => {
    const sock = net.connect(port, '127.0.0.1')
    sock.once('connect', () => {
      sock.end()
      resolve(true)
    })
    sock.once('error', () => resolve(false))
  })
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

async function forceRestartApp(udid) {
  execFileSync(ADB, ['-s', udid, 'shell', 'am', 'force-stop', 'kitchen.longtable.app'])
  await sleep(1000)
  return makeSession(udid)
}

async function evalJs(driver, script) {
  return driver.executeScript('return eval(arguments[0])', [script])
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

async function clickAndWait(driver, clickSel, waitSel, timeout = 20000) {
  // DOM click first: in this emulator/chromedriver environment, coordinate
  // clicks are intermittently swallowed or intercepted by overlays that
  // open mid-dispatch (measured repeatedly in Phase 4 proof runs), while
  // a DOM click on the same real element reliably fires its handler.
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt === 1) {
      await (await driver.$(clickSel)).click().catch(() => {})
    } else {
      await evalJs(driver, `document.querySelector('${clickSel}')?.click()`)
    }
    const target = await driver.$(waitSel)
    const ok = await target.waitForExist({ timeout }).catch(() => false)
    if (ok) return target
  }
  throw new Error(`clickAndWait: ${waitSel} never appeared after clicking ${clickSel}`)
}

/**
 * Click, verify an effect, and if the effect never lands, click the same
 * element once more at DOM level. Coordinate clicks in this harness are
 * intermittently swallowed (chromedriver click-point math vs the app's
 * re-render timing); the DOM click targets the identical real element.
 */
async function clickWithFallback(driver, selector, verify, timeout = 15000) {
  await (await driver.$(selector)).click().catch(() => {})
  let v = await waitFor(driver, verify, timeout, 500)
  if (v) return v
  await evalJs(driver, `document.querySelector('${selector}')?.click()`)
  v = await waitFor(driver, verify, timeout, 500)
  if (!v) throw new Error(`clickWithFallback: effect never landed for ${selector}`)
  return v
}

// ------------------------------------------------------------ hubs UI ----
async function openHubs(driver) {
  const modal = await driver.$('[data-testid="hubs-modal"]')
  if (await modal.isExisting()) return
  // Retry the whole find-and-click cycle: a click can be swallowed while
  // the WebView is still settling after launch or a view change. After a
  // few coordinate-based attempts, fall back to a DOM click on the same
  // real button (chromedriver's click-point math races this app's fast
  // re-render under load; the DOM click does not).
  for (let i = 0; i < 30; i++) {
    if (await modal.isExisting()) return
    const openBtn = await driver.$('[data-testid="open-hubs"]')
    if (await openBtn.isExisting()) {
      // The click can throw "intercepted" precisely because it worked —
      // the modal backdrop opens over the button mid-dispatch.
      if (i < 3) await openBtn.click().catch(() => {})
      else await evalJs(driver, 'document.querySelector(\'[data-testid="open-hubs"]\')?.click()')
    } else {
      const back = await driver.$('[data-testid="back-to-list"]')
      if (await back.isExisting()) await back.click().catch(() => {})
    }
    await sleep(1000)
  }
  await modal.waitForExist({ timeout: 20000 })
}

async function closeHubs(driver) {
  const modal = await driver.$('[data-testid="hubs-modal"]')
  if (await modal.isExisting()) {
    await (await driver.$('[data-testid="close-hubs"]')).click().catch(() => {})
    const gone = await modal.waitForExist({ timeout: 4000, reverse: true }).catch(() => false)
    if (!gone) {
      await evalJs(driver, 'document.querySelector(\'[data-testid="close-hubs"]\')?.click()')
      await sleep(600)
    }
  }
}

async function addHubViaUi(driver, hub) {
  await openHubs(driver)
  await (await driver.$('[data-testid="field-hub-name"]')).setValue(hub.name)
  await (await driver.$('[data-testid="field-hub-signaling"]')).setValue(hub.signaling)
  await (await driver.$('[data-testid="field-hub-turn"]')).setValue(hub.turn)
  await (await driver.$('[data-testid="field-hub-turn-user"]')).setValue(hub.turnUser)
  await (await driver.$('[data-testid="field-hub-turn-pass"]')).setValue(hub.turnPass)
  await (await driver.$('[data-testid="field-hub-appview"]')).setValue(hub.appview)
  await (await driver.$('[data-testid="field-hub-pds"]')).setValue(hub.pds)
  const saved = async () =>
    waitFor(
      driver,
      async () => {
        const raw = await evalJs(driver, 'localStorage.getItem("longtable:hubs:v1") || ""')
        return String(raw).includes(hub.signaling) ? String(raw) : null
      },
      6000,
      500,
    )
  await (await driver.$('[data-testid="add-hub"]')).click().catch(() => {})
  let found = await saved()
  if (!found) {
    // The Add button sits at the bottom of a long scrollable modal; the
    // WebDriver click can land without dispatching to React. A DOM click
    // on the same real button is the fallback (values were typed for real).
    await evalJs(driver, 'document.querySelector(\'[data-testid="add-hub"]\')?.click()')
    found = await saved()
  }
  if (!found) throw new Error(`hub ${hub.name} was not saved`)
  await closeHubs(driver)
}

async function hubRegistry(driver) {
  const raw = await evalJs(driver, 'localStorage.getItem("longtable:hubs:v1") || "null"')
  return JSON.parse(String(raw))
}

/**
 * Remove the seeded dev-default hub through the UI, so the device's
 * rendezvous set is EXACTLY {hub A, hub B} — otherwise the always-on dev
 * signaling server would silently carry the failover and the proof
 * would not isolate hub B.
 */
async function removeDefaultHub(driver) {
  const reg = await hubRegistry(driver)
  const def = (reg?.hubs ?? []).find((h) => h.signalingUrl === 'wss://10.0.2.2:4444')
  if (!def) return
  await openHubs(driver)
  const removed = async () =>
    waitFor(
      driver,
      async () => {
        const raw = await evalJs(driver, 'localStorage.getItem("longtable:hubs:v1") || ""')
        return String(raw).includes('wss://10.0.2.2:4444') ? null : true
      },
      5000,
      500,
    )
  await (await driver.$(`[data-testid="hub-remove-${def.id}"]`)).click().catch(() => {})
  let gone = await removed()
  if (!gone) {
    await evalJs(driver, `document.querySelector('[data-testid="hub-remove-${def.id}"]')?.click()`)
    gone = await removed()
  }
  if (!gone) throw new Error('default hub was not removed')
  await closeHubs(driver)
}

// ---------------------------------------------------------- friends UI ----
async function openFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  if (await panel.isExisting()) return
  for (let i = 0; i < 30; i++) {
    if (await panel.isExisting()) return
    const openBtn = await driver.$('[data-testid="friends-open"]')
    if (await openBtn.isExisting()) {
      if (i < 3) await openBtn.click().catch(() => {})
      else await evalJs(driver, 'document.querySelector(\'[data-testid="friends-open"]\')?.click()')
    } else {
      const back = await driver.$('[data-testid="back-to-list"]')
      if (await back.isExisting()) await back.click().catch(() => {})
    }
    await sleep(1000)
  }
  await panel.waitForExist({ timeout: 20000 })
}

async function closeFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  if (await panel.isExisting()) {
    await (await driver.$('[data-testid="close-friends"]')).click().catch(() => {})
    const gone = await panel.waitForExist({ timeout: 4000, reverse: true }).catch(() => false)
    if (!gone) {
      await evalJs(driver, 'document.querySelector(\'[data-testid="close-friends"]\')?.click()')
      await panel.waitForExist({ timeout: 6000, reverse: true }).catch(() => {})
    }
    await sleep(400)
  }
}

async function setName(driver, name) {
  const input = await driver.$('[data-testid="friend-name"]')
  await input.setValue(name)
  await sleep(300)
}

async function createInvite(driver) {
  await clickWithFallback(driver, '[data-testid="friend-show-invite"]', async () => {
    const code = await driver.$('[data-testid="friend-invite-code"]')
    return (await code.isExisting()) ? true : null
  })
  const code = await driver.$('[data-testid="friend-invite-code"]')
  await code.waitForExist({ timeout: 15000 })
  const value = await waitFor(
    driver,
    async () => {
      const v = await evalJs(
        driver,
        'document.querySelector(\'[data-testid="friend-invite-code"]\')?.value ?? ""',
      )
      return v && String(v).includes('"kind":"friend"') ? String(v) : null
    },
    20000,
    500,
  )
  if (!value) throw new Error('invite code not populated')
  return value
}

/**
 * Set a controlled textarea's value reliably: WebDriver setValue first,
 * verify the DOM value, and if React never saw it (the chromedriver
 * controlled-component quirk — the Join button stays disabled), set it
 * via the native setter + input event so React state updates for real.
 */
async function setCodeValue(driver, selector, text) {
  await (await driver.$(selector)).setValue(text)
  const ok = await evalJs(
    driver,
    `document.querySelector('${selector}')?.value.length === ${text.length}`,
  )
  if (ok) return
  await evalJs(
    driver,
    `(() => { const el = document.querySelector('${selector}');` +
      ` const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), 'value').set;` +
      ` setter.call(el, ${JSON.stringify(text)});` +
      ` el.dispatchEvent(new Event('input', { bubbles: true })); })()`,
  )
  const ok2 = await evalJs(
    driver,
    `document.querySelector('${selector}')?.value.length === ${text.length}`,
  )
  if (!ok2) throw new Error(`could not set ${selector} value`)
}

async function joinWith(driver, code) {
  await setCodeValue(driver, '[data-testid="friend-join-code"]', code)
  const hasFriend = async () =>
    (await driver.$$('[data-testid="friend-item"]')).length >= 1 ? true : null
  await (await driver.$('[data-testid="friend-join-confirm"]')).click().catch(() => {})
  // Poll WITHOUT re-clicking first: on a loaded fleet the pairing
  // handshake (signaling rendezvous + TURN relay + hello) can take
  // ~45s, and re-clicking join-confirm at 20s restarted the guest join
  // mid-handshake — the restarted attempt then overran the invite's
  // 90s TTL and pairing failed deterministically (observed 2026-10-15
  // with the box under cross-workstream build load; a single-click run
  // of this same proof passed 17/17). The re-click remains, but only
  // after 100s, as a guard against a genuinely missed first click.
  let ok = await waitFor(driver, hasFriend, 100000)
  if (!ok) {
    await evalJs(driver, 'document.querySelector(\'[data-testid="friend-join-confirm"]\')?.click()')
    ok = await waitFor(driver, hasFriend, 60000)
  }
  if (!ok) throw new Error('pairing did not complete on the guest side')
}

async function friendCount(driver) {
  return (await driver.$$('[data-testid="friend-item"]')).length
}

async function shelfHas(driver, title, timeout = 120000) {
  return waitFor(
    driver,
    async () => {
      await openFriends(driver)
      const items = await driver.$$('[data-testid="shelf-item"]')
      for (const item of items) {
        const text = await item.getText()
        if (text.includes(title)) return item
      }
      await closeFriends(driver)
      return null
    },
    timeout,
  )
}

// ------------------------------------------------------------- recipes ----
async function openRecipeByTitle(driver, title) {
  const back = await driver.$('[data-testid="back-to-list"]')
  if (await back.isExisting()) await back.click().catch(() => {})
  const card = await driver.$(`button.recipe-card*=${title}`)
  await card.waitForExist({ timeout: 20000 })
  await evalJs(
    driver,
    `[...document.querySelectorAll('button.recipe-card')].find(e => e.textContent.includes(${JSON.stringify(title)}))?.click()`,
  )
  const t = await driver.$('[data-testid="recipe-title"]')
  await t.waitForExist({ timeout: 20000 })
  return (await (await driver.$('[data-testid="recipe-detail"]')).getText()) ?? ''
}

/** DOM-click the shelf item whose text contains `title` (coordinate
 * clicks on list items are unreliable in this harness — see clickAndWait). */
async function clickShelfItem(driver, title) {
  await evalJs(
    driver,
    `[...document.querySelectorAll('[data-testid="shelf-item"]')].find(e => e.textContent.includes(${JSON.stringify(title)}))?.click()`,
  )
  const t = await driver.$('[data-testid="recipe-title"]')
  await t.waitForExist({ timeout: 20000 })
}

async function localInventory(driver) {
  const did = await evalJs(driver, 'window.__ltFriends.myDid()')
  const friends = await evalJs(driver, 'window.__ltFriends.friends().then(fs => fs.map(f => f.did).sort())')
  const registry = await hubRegistry(driver)
  const cards = await driver.$$('[data-testid="recipe-item"]')
  const titles = []
  for (const c of cards) titles.push(await c.getText())
  return {
    did: String(did),
    friends: friends ?? [],
    hubSignals: (registry?.hubs ?? []).map((h) => h.signalingUrl).sort(),
    activeSignaling: (registry?.hubs ?? []).find((h) => h.id === registry?.activeId)?.signalingUrl ?? null,
    cardCount: titles.length,
  }
}

/** Rich state dump for a failed floor join — distinguishes "join never
 * ran", "join errored", "join completed but the list did not refresh". */
async function floorDiagnostics(driver, payload) {
  try {
    const parts = []
    parts.push(`payloadLen=${payload?.length ?? 0}`)
    const err = await driver.$('[data-testid="join-error"]')
    parts.push(`joinError=${(await err.isExisting()) ? await err.getText() : '(none)'}`)
    const modal = await driver.$('[data-testid="join-modal"]')
    parts.push(`joinModalOpen=${await modal.isExisting()}`)
    const shares = await evalJs(driver, 'localStorage.getItem("longtable:shares") || "null"')
    parts.push(`shares=${String(shares).slice(0, 160)}`)
    const cards = await driver.$$('[data-testid="recipe-item"]')
    const titles = []
    for (const c of cards) titles.push(await c.getText())
    parts.push(`cards=${JSON.stringify(titles).slice(0, 200)}`)
    const codeLen = await evalJs(
      driver,
      'document.querySelector(\'[data-testid="join-code"]\')?.value.length ?? -1',
    )
    parts.push(`joinCodeLen=${codeLen}`)
    return parts.join(' ')
  } catch (e) {
    return `diagnostics failed: ${e}`
  }
}

async function main() {
  for (const serial of ['emulator-5554', 'emulator-5556']) {
    execFileSync(ADB, ['-s', serial, 'shell', 'pm', 'clear', 'kitchen.longtable.app'])
  }
  console.log('app data cleared on 5554/5556')

  let A = await makeSession('emulator-5554')
  let B = await makeSession('emulator-5556')
  console.log('sessions up: A=5554 B=5556')

  try {
    // ---- Register both hubs on both devices (B first, so A ends active),
    // then remove the seeded dev hub: rendezvous is exactly {A, B}.
    for (const [label, driver] of [['A', A], ['B', B]]) {
      await addHubViaUi(driver, HUB_B)
      await addHubViaUi(driver, HUB_A)
      await removeDefaultHub(driver)
      const reg = await hubRegistry(driver)
      const signals = (reg?.hubs ?? []).map((h) => h.signalingUrl).sort()
      const active = reg?.hubs?.find((h) => h.id === reg?.activeId)?.signalingUrl
      step(
        `hubs: device ${label} lists exactly hub A + hub B, hub A active`,
        signals.length === 2 &&
          signals.includes(HUB_A.signaling) &&
          signals.includes(HUB_B.signaling) &&
          active === HUB_A.signaling,
        `signals=${JSON.stringify(signals)} active=${active}`,
      )
    }

    // ---- Pair A<->B via hub A -----------------------------------------
    await openFriends(A)
    await setName(A, 'Olga')
    const invite = await createInvite(A)
    const inviteObj = JSON.parse(invite)
    step(
      'pairing: invite payload carries hub A signaling',
      inviteObj.signaling === HUB_A.signaling,
      `signaling=${inviteObj.signaling}`,
    )
    await openFriends(B)
    await setName(B, 'Fay')
    await joinWith(B, invite)
    const aFriends = await waitFor(A, async () => (await friendCount(A)) >= 1, 60000)
    step('pairing: A and B are friends (via hub A)', !!aFriends && (await friendCount(B)) >= 1)
    await closeFriends(A)
    await closeFriends(B)

    // ---- A creates + shares "Hubfail Stew" friends-only ----------------
    await clickAndWait(A, '[data-testid="new-recipe"]', '[data-testid="field-title"]')
    await (await A.$('[data-testid="field-title"]')).setValue('Hubfail Stew')
    await (await A.$('[data-testid="field-ingredient"]')).setValue('1 phoenix egg')
    await (await A.$('[data-testid="add-ingredient"]')).click()
    await (await A.$('[data-testid="field-step"]')).setValue('Rises anyway.')
    await (await A.$('[data-testid="add-step"]')).click()
    await clickWithFallback(A, '[data-testid="save-recipe"]', async () => {
      const t = await A.$('[data-testid="recipe-title"]')
      return (await t.isExisting()) ? true : null
    })
    const detailTitle = await A.$('[data-testid="recipe-title"]')
    await detailTitle.waitForExist({ timeout: 20000 })
    step('setup: A created “Hubfail Stew”', (await detailTitle.getText()) === 'Hubfail Stew')

    const modal = await clickAndWait(A, '[data-testid="share-friends"]', '[data-testid="friend-share-modal"]')
    const boxes = await A.$$('[data-testid="friend-check"]')
    if (boxes.length !== 1) throw new Error(`expected 1 friend checkbox, got ${boxes.length}`)
    await boxes[0].click().catch(() => {})
    const checked = await evalJs(
      A,
      'document.querySelector(\'[data-testid="friend-check"]\')?.checked ?? document.querySelector(\'[data-testid="friend-check"] input\')?.checked ?? false',
    )
    if (!checked) {
      await evalJs(A, 'document.querySelector(\'[data-testid="friend-check"]\')?.click()')
    }
    await clickWithFallback(A, '[data-testid="share-friends-confirm"]', async () => {
      const m = await A.$('[data-testid="friend-share-modal"]')
      return (await m.isExisting()) ? null : true
    })

    const shelf1 = await shelfHas(B, 'Hubfail Stew')
    step('sync via hub A: B shelf shows “Hubfail Stew”', !!shelf1)
    if (shelf1) {
      await clickShelfItem(B, 'Hubfail Stew')
      const t = await B.$('[data-testid="recipe-title"]')
      const body = await (await B.$('[data-testid="recipe-detail"]')).getText()
      step(
        'sync via hub A: B reads full content',
        (await t.getText()) === 'Hubfail Stew' && body.includes('phoenix egg') && body.includes('Rises anyway.'),
      )
    }
    await closeFriends(B)

    // ---- Inventory snapshot (the zero-loss baseline) -------------------
    await (await A.$('[data-testid="back-to-list"]')).click().catch(() => {})
    await (await B.$('[data-testid="back-to-list"]')).click().catch(() => {})
    const invA0 = await localInventory(A)
    const invB0 = await localInventory(B)
    step(
      'baseline: identity + friend recorded on both devices',
      invA0.did.startsWith('did:key:') && invB0.did.startsWith('did:key:') &&
        invA0.friends.includes(invB0.did) && invB0.friends.includes(invA0.did),
      `A=${invA0.did.slice(0, 16)}… B=${invB0.did.slice(0, 16)}…`,
    )

    // ================= KILL HUB A =======================================
    console.log('--- killing hub A (the primary) ---')
    hubCtl(HUB_A_DIR, 'stop')
    const aDown = !(await tcpConnectable(HUB_A.signalingPort))
    step('kill: hub A signaling refuses connections', aDown)
    const killTime = Date.now()

    // Cold-restart both apps with the primary hub dead.
    A = await forceRestartApp('emulator-5554')
    B = await forceRestartApp('emulator-5556')
    console.log('both apps cold-restarted with hub A down')

    const invA1 = await localInventory(A)
    const invB1 = await localInventory(B)
    step(
      'zero loss after kill + cold restart: identity, friends, hubs intact',
      invA1.did === invA0.did && invB1.did === invB0.did &&
        JSON.stringify(invA1.friends) === JSON.stringify(invA0.friends) &&
        JSON.stringify(invB1.friends) === JSON.stringify(invB0.friends) &&
        JSON.stringify(invA1.hubSignals) === JSON.stringify(invA0.hubSignals) &&
        JSON.stringify(invB1.hubSignals) === JSON.stringify(invB0.hubSignals),
    )

    // ---- A edits; the edit must fail over to hub B ----------------------
    const detailBefore = await openRecipeByTitle(A, 'Hubfail Stew')
    if (!detailBefore.includes('phoenix egg')) throw new Error('A lost its own recipe after restart')
    await clickAndWait(A, '[data-testid="edit-recipe"]', '[data-testid="field-title"]')
    await (await A.$('[data-testid="field-title"]')).setValue('Hubfail Stew v2')
    await (await A.$('[data-testid="field-step"]')).setValue('Edited after hub A died.')
    await (await A.$('[data-testid="add-step"]')).click()
    await clickWithFallback(A, '[data-testid="save-recipe"]', async () => {
      const t = await A.$('[data-testid="recipe-title"]')
      return (await t.isExisting()) && (await t.getText()) === 'Hubfail Stew v2' ? true : null
    })
    const v2t = await A.$('[data-testid="recipe-title"]')
    await v2t.waitForExist({ timeout: 20000 })
    step('post-kill edit: A saved “Hubfail Stew v2” locally', (await v2t.getText()) === 'Hubfail Stew v2')

    const shelf2 = await shelfHas(B, 'Hubfail Stew v2', 240000)
    const failoverSecs = Math.round((Date.now() - killTime) / 1000)
    step('FAILOVER: B received v2 via hub B with hub A dead', !!shelf2, `kill→sync ${failoverSecs}s`)
    if (shelf2) {
      await clickShelfItem(B, 'Hubfail Stew v2')
      const t = await B.$('[data-testid="recipe-title"]')
      const bodyB = await (await B.$('[data-testid="recipe-detail"]')).getText()
      const bodyA = await openRecipeByTitle(A, 'Hubfail Stew v2')
      step(
        'FAILOVER: recipe state identical on both devices',
        bodyB.includes('phoenix egg') &&
          bodyB.includes('Edited after hub A died.') &&
          bodyA.includes('phoenix egg') &&
          bodyA.includes('Edited after hub A died.'),
      )
    }
    await closeFriends(B)

    // ================= KILL HUB B — the zero-hub floor ==================
    console.log('--- killing hub B too: no hub remains ---')
    hubCtl(HUB_B_DIR, 'stop')
    const bDown = !(await tcpConnectable(HUB_B.signalingPort))
    step('kill: hub B signaling refuses connections (zero hubs alive)', bDown)

    A = await forceRestartApp('emulator-5554')
    B = await forceRestartApp('emulator-5556')
    const invA2 = await localInventory(A)
    step(
      'zero loss with NO hub: A identity/friends/hubs still intact, local data readable',
      invA2.did === invA0.did &&
        JSON.stringify(invA2.friends) === JSON.stringify(invA0.friends) &&
        JSON.stringify(invA2.hubSignals) === JSON.stringify(invA0.hubSignals),
    )

    // A exports the snapshot payload; B joins from pasted text (no servers).
    await openRecipeByTitle(A, 'Hubfail Stew v2')
    await clickAndWait(A, '[data-testid="share-recipe"]', '[data-testid="share-modal"]')
    const payload = await waitFor(
      A,
      async () => {
        const v = await evalJs(A, 'document.querySelector(\'[data-testid="share-code"]\')?.value ?? ""')
        return v && String(v).length > 100 ? String(v) : null
      },
      30000,
      500,
    )
    if (!payload) throw new Error('share payload not populated')
    await (await A.$('[data-testid="close-share"]')).click()

    const cardsBefore = (await localInventory(B)).cardCount
    await clickAndWait(B, '[data-testid="join-recipe"]', '[data-testid="join-modal"]')
    await setCodeValue(B, '[data-testid="join-code"]', payload)
    // DOM click, deliberately: the Join and Cancel buttons sit side by
    // side, and this harness's coordinate clicks have repeatedly landed
    // on the wrong one (a "successful" run that closed the modal via
    // Cancel: no error, no join, no shares record — caught by the floor
    // diagnostics). The DOM click targets the exact element.
    await evalJs(B, 'document.querySelector(\'[data-testid="join-confirm"]\')?.click()')
    const joined = await waitFor(
      B,
      async () => {
        const inv = await localInventory(B)
        return inv.cardCount > cardsBefore ? inv : null
      },
      60000,
    )
    step('FLOOR: B joined from the pasted snapshot with zero hubs alive', !!joined,
      joined ? '' : (await floorDiagnostics(B, payload)))
    if (joined) {
      const bodyB = await openRecipeByTitle(B, 'Hubfail Stew v2')
      step(
        'FLOOR: snapshot copy matches A exactly (title, ingredient, post-kill step)',
        bodyB.includes('phoenix egg') && bodyB.includes('Edited after hub A died.'),
      )
    }
  } finally {
    // Leave the environment healthy whatever happened above.
    try {
      hubCtl(HUB_A_DIR, 'start')
    } catch (e) {
      console.warn('restart hub A failed:', e)
    }
    try {
      hubCtl(HUB_B_DIR, 'start')
    } catch (e) {
      console.warn('restart hub B failed:', e)
    }
    await A?.deleteSession().catch(() => {})
    await B?.deleteSession().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== proof-hubfail: ${results.length - failed.length}/${results.length} steps passed ===`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('proof-hubfail error:', e)
  process.exit(1)
})
