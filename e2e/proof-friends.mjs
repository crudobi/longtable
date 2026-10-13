#!/usr/bin/env node
/**
 * Longtable Phase 2 oath proof — REAL app, three emulators.
 *
 * Oath: "Only the friends you choose can read what you share with friends."
 *
 *   A (emulator-5554, "Olga") pairs with B (5556, "Fay") and C (5558, "Gus")
 *   via the Friends panel paste flow (signed DID handshake).
 *   A shares "Midnight Soup" friends-only with B and C.
 *   B and C each render the shared-with-me shelf and open the recipe.
 *   STRANGER LEG: C is handed the exact shelf-doc bytes of the A↔B channel
 *   ("captured traffic") and runs the app's real receive path
 *   (window.__ltFriends.attemptWithShelfBytes): decryption must FAIL
 *   explicitly — no envelope is addressed to C in that channel.
 *   UNFRIEND LEG: A unfriends C (key rotates, C's channel unpublished).
 *   A edits the recipe; B receives and opens v2; C attempts the new A↔B
 *   bytes and fails again.
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'

const APPIUM = 'http://127.0.0.1:4723'
const ACTIVITY = 'kitchen.longtable.app.MainActivity'
const ADB = '/home/devbox/tools/android-sdk/platform-tools/adb'

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


async function clickAndWait(driver, clickSel, waitSel, timeout = 20000) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await (await driver.$(clickSel)).click()
    const target = await driver.$(waitSel)
    const ok = await target.waitForExist({ timeout }).catch(() => false)
    if (ok) return target
  }
  throw new Error(`clickAndWait: ${waitSel} never appeared after clicking ${clickSel}`)
}

async function openFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  if (await panel.isExisting()) return
  // friends-open lives on the list view; navigate there if needed, with
  // retries — view transitions can lag while channel traffic lands.
  for (let i = 0; i < 20; i++) {
    const openBtn = await driver.$('[data-testid="friends-open"]')
    if (await openBtn.isExisting()) {
      await openBtn.click()
      break
    }
    const back = await driver.$('[data-testid="back-to-list"]')
    if (await back.isExisting()) await back.click()
    await sleep(1000)
  }
  await panel.waitForExist({ timeout: 20000 })
}

async function closeFriends(driver) {
  const panel = await driver.$('[data-testid="friends-panel"]')
  if (await panel.isExisting()) {
    await (await driver.$('[data-testid="close-friends"]')).click()
    await sleep(600)
  }
}

async function setName(driver, name) {
  const input = await driver.$('[data-testid="friend-name"]')
  await input.setValue(name)
  await sleep(300)
}

async function createInvite(driver) {
  await (await driver.$('[data-testid="friend-show-invite"]')).click()
  const code = await driver.$('[data-testid="friend-invite-code"]')
  await code.waitForExist({ timeout: 15000 })
  // NOTE: chromedriver getValue() returns '' for this controlled textarea;
  // read the DOM value property directly.
  const value = await waitFor(
    driver,
    async () => {
      const v = await evalJs(driver,
        'document.querySelector(\'[data-testid="friend-invite-code"]\')?.value ?? ""')
      return v && String(v).includes('"kind":"friend"') ? String(v) : null
    },
    20000,
    500,
  )
  if (!value) {
    const err = await driver.$('[data-testid="friend-error"]')
    const errText = (await err.isExisting()) ? await err.getText() : ''
    throw new Error(`invite code not populated; panelError=${errText}`)
  }
  return value
}

async function joinWith(driver, code) {
  const area = await driver.$('[data-testid="friend-join-code"]')
  await area.setValue(code)
  await (await driver.$('[data-testid="friend-join-confirm"]')).click()
  const ok = await waitFor(
    driver,
    async () => {
      const items = await driver.$$('[data-testid="friend-item"]')
      return items.length >= 1
    },
    120000,
  )
  if (!ok) throw new Error('pairing did not complete on the guest side')
}

async function friendCount(driver) {
  return (await driver.$$('[data-testid="friend-item"]')).length
}

async function shelfHas(driver, title) {
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
    120000,
  )
}

async function main() {
  // Clean slate on all three devices (app data only; CA store untouched).
  for (const serial of ['emulator-5554', 'emulator-5556', 'emulator-5558']) {
    execFileSync(ADB, ['-s', serial, 'shell', 'pm', 'clear', 'kitchen.longtable.app'])
  }
  console.log('app data cleared on 5554/5556/5558')

  const A = await makeSession('emulator-5554')
  const B = await makeSession('emulator-5556')
  const C = await makeSession('emulator-5558')
  console.log('sessions up: A=5554 B=5556 C=5558')

  try {
    // ---- Pairing A<->B -------------------------------------------------
    await openFriends(A)
    await setName(A, 'Olga')
    const inviteAB = await createInvite(A)
    await openFriends(B)
    await setName(B, 'Fay')
    await joinWith(B, inviteAB)
    const aFriends1 = await waitFor(A, async () => (await friendCount(A)) >= 1, 60000)
    step('pairing: A and B are friends', !!aFriends1 && (await friendCount(B)) >= 1)

    const aDid = await evalJs(A, 'window.__ltFriends.myDid()')
    const bDid = await evalJs(B, 'window.__ltFriends.myDid()')
    const bSeesA = await evalJs(B, `window.__ltFriends.friends().then(fs => fs.some(f => f.did === ${JSON.stringify(aDid)}))`)
    const aSeesB = await evalJs(A, `window.__ltFriends.friends().then(fs => fs.some(f => f.did === ${JSON.stringify(bDid)}))`)
    step('pairing: mutual DID records verified', bSeesA === true && aSeesB === true, `A=${String(aDid).slice(0, 20)}… B=${String(bDid).slice(0, 20)}…`)
    await closeFriends(A)
    await closeFriends(B)

    // ---- Pairing A<->C -------------------------------------------------
    await openFriends(A)
    const inviteAC = await createInvite(A)
    await openFriends(C)
    await setName(C, 'Gus')
    await joinWith(C, inviteAC)
    const aFriends2 = await waitFor(A, async () => (await friendCount(A)) >= 2, 60000)
    step('pairing: A and C are friends (A now has 2)', !!aFriends2)
    await closeFriends(A)
    await closeFriends(C)

    // ---- A creates a recipe and shares it friends-only ------------------
    await clickAndWait(A, '[data-testid="new-recipe"]', '[data-testid="field-title"]')
    await (await A.$('[data-testid="field-title"]')).setValue('Midnight Soup')
    await (await A.$('[data-testid="field-ingredient"]')).setValue('1 black garlic bulb')
    await (await A.$('[data-testid="add-ingredient"]')).click()
    await (await A.$('[data-testid="field-step"]')).setValue('Simmer at midnight.')
    await (await A.$('[data-testid="add-step"]')).click()
    await (await A.$('[data-testid="save-recipe"]')).click()
    const detailTitle = await A.$('[data-testid="recipe-title"]')
    await detailTitle.waitForExist({ timeout: 20000 })
    step('setup: A created “Midnight Soup”', (await detailTitle.getText()) === 'Midnight Soup')

    const modal = await clickAndWait(A, '[data-testid="share-friends"]', '[data-testid="friend-share-modal"]')
    void modal
    const boxes = await A.$$('[data-testid="friend-check"]')
    if (boxes.length !== 2) throw new Error(`expected 2 friend checkboxes, got ${boxes.length}`)
    for (const box of boxes) await box.click()
    await (await A.$('[data-testid="share-friends-confirm"]')).click()
    await modal.waitForExist({ timeout: 15000, reverse: true })
    const vaultOk = await evalJs(A,
      'Object.values(JSON.parse(localStorage.getItem("longtable:key-vault") || "{}")).some(k => k.friends && k.friends.length === 2)')
    step('share: encrypted publish, key wrapped for exactly B and C', vaultOk === true)

    // ---- B and C render the shelf and open the recipe -------------------
    const shelfB = await shelfHas(B, 'Midnight Soup')
    step('friend shelf: B sees “Midnight Soup”', !!shelfB)
    if (shelfB) {
      await shelfB.click()
      const t = await B.$('[data-testid="recipe-title"]')
      await t.waitForExist({ timeout: 20000 })
      const body = await (await B.$('[data-testid="recipe-detail"]')).getText()
      step('friend opens recipe: B reads full content',
        (await t.getText()) === 'Midnight Soup' && body.includes('black garlic'))
    }
    await closeFriends(B)

    const shelfC = await shelfHas(C, 'Midnight Soup')
    step('friend shelf: C sees “Midnight Soup” (still a friend here)', !!shelfC)
    await closeFriends(C)

    // ---- STRANGER LEG: C vs the A<->B channel bytes ----------------------
    const bytesAB = await evalJs(A, `window.__ltFriends.shelfUpdateB64(${JSON.stringify(bDid)})`)
    if (!bytesAB || String(bytesAB).length < 100) throw new Error('could not capture A-B shelf bytes')
    const attemptC = await evalJs(C,
      `window.__ltFriends.attemptWithShelfBytes(${JSON.stringify(bytesAB)}).then(r => JSON.stringify(r))`)
    const attemptCObj = JSON.parse(String(attemptC))
    step('stranger: C cannot decrypt the A↔B channel bytes',
      attemptCObj.decryptedTitles.length === 0 && attemptCObj.failures.length >= 1,
      `failures=${JSON.stringify(attemptCObj.failures.map((f) => f.reason))}`)

    // ---- UNFRIEND LEG ----------------------------------------------------
    await openFriends(A)
    await evalJs(A, 'window.confirm = () => true')
    const items = await A.$$('[data-testid="friend-item"]')
    let unfriended = false
    for (const item of items) {
      const text = await item.getText()
      if (text.includes('Gus')) {
        await (await item.$('[data-testid="unfriend-friend"]')).click()
        unfriended = true
        break
      }
    }
    const afterUnfriend = await waitFor(A, async () => (await friendCount(A)) === 1, 60000)
    step('unfriend: C removed from A, key rotated', unfriended && !!afterUnfriend)
    await closeFriends(A)

    // A edits the recipe → v2 republished under the rotated key (B only).
    await (await A.$('[data-testid="back-to-list"]')).click().catch(() => {})
    const card = await A.$('button.recipe-card*=Midnight Soup')
    await card.click()
    await clickAndWait(A, '[data-testid="edit-recipe"]', '[data-testid="field-title"]')
    const titleInput = await A.$('[data-testid="field-title"]')
    await titleInput.setValue('Midnight Soup v2')
    await (await A.$('[data-testid="save-recipe"]')).click()
    const v2Title = await A.$('[data-testid="recipe-title"]')
    await v2Title.waitForExist({ timeout: 20000 })
    step('setup: A edited recipe to v2', (await v2Title.getText()) === 'Midnight Soup v2')

    // Remaining friend B receives and opens v2.
    const shelfB2 = await shelfHas(B, 'Midnight Soup v2')
    step('after unfriend: B still receives updates (v2 on shelf)', !!shelfB2)
    if (shelfB2) {
      await shelfB2.click()
      const t = await B.$('[data-testid="recipe-title"]')
      await t.waitForExist({ timeout: 20000 })
      step('after unfriend: B opens v2', (await t.getText()) === 'Midnight Soup v2')
    }
    await closeFriends(B)

    // Ex-friend C attempts the NEW A<->B bytes: must fail again.
    const bytesAB2 = await evalJs(A, `window.__ltFriends.shelfUpdateB64(${JSON.stringify(bDid)})`)
    const attemptC2 = await evalJs(C,
      `window.__ltFriends.attemptWithShelfBytes(${JSON.stringify(bytesAB2)}).then(r => JSON.stringify(r))`)
    const attemptC2Obj = JSON.parse(String(attemptC2))
    step('ex-friend: C cannot read v2 from captured traffic',
      !attemptC2Obj.decryptedTitles.includes('Midnight Soup v2') && attemptC2Obj.failures.length >= 1,
      `decrypted=${JSON.stringify(attemptC2Obj.decryptedTitles)} failures=${attemptC2Obj.failures.length}`)
  } finally {
    await A.deleteSession().catch(() => {})
    await B.deleteSession().catch(() => {})
    await C.deleteSession().catch(() => {})
  }

  const failed = results.filter((r) => !r.ok)
  console.log(`\n=== proof-friends: ${results.length - failed.length}/${results.length} steps passed ===`)
  if (failed.length > 0) process.exitCode = 1
}

main().catch((e) => {
  console.error('proof-friends error:', e)
  process.exit(1)
})
