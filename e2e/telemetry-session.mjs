#!/usr/bin/env node
/**
 * Telemetry audit session driver (Phase 4) — NOT a proof with steps; a
 * scripted, representative app session executed while telemetry-audit.sh
 * records every socket the emulator and hub processes open:
 *
 *   1. Both apps launch (signaling connections to all configured hubs,
 *      friend channels rejoin — encrypted sync traffic flows).
 *   2. A edits the shared recipe; B receives it (WebRTC, TURN if needed).
 *   3. B opens Discover and searches the active hub's AppView.
 *
 * Precondition: the devices are already paired and hub-registered
 * (proof-hubfail.mjs leaves them exactly so, with both hubs running).
 */
import { remote } from 'webdriverio'
import { execFileSync } from 'node:child_process'

const ACTIVITY = 'kitchen.longtable.app.MainActivity'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
// Host layout derives from this file's location (env LT_ROOT wins):
// the repo is <LT_ROOT>/code/longtable.
const LT_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const LT_ROOT = process.env.LT_ROOT ?? path.resolve(LT_REPO, '..', '..')
const LT_ADB = process.env.ADB ?? path.join(LT_ROOT, 'tools/android-sdk/platform-tools/adb')
const ADB = LT_ADB
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  await driver.execute('mobile: startActivity', { component: `kitchen.longtable.app/${ACTIVITY}` })
  await sleep(1500)
  const contexts = await driver.getContexts()
  const webview = contexts.find((c) => c.startsWith('WEBVIEW'))
  if (!webview) throw new Error(`no webview on ${udid}`)
  await driver.switchContext(webview)
  await (await driver.$('[data-testid="new-recipe"]')).waitForExist({ timeout: 30000 })
  return driver
}

async function waitFor(driver, fn, timeout = 120000, interval = 2000) {
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

async function main() {
  // Cold-start both apps (force-stop first): a resumed app can sit on a
  // detail view, and the cold start is also what rejoins every channel.
  for (const s of ['emulator-5554', 'emulator-5556']) {
    execFileSync(ADB, ['-s', s, 'shell', 'am', 'force-stop', 'kitchen.longtable.app'])
  }
  await sleep(1000)
  const A = await makeSession('emulator-5554')
  const B = await makeSession('emulator-5556')
  console.log('[audit-session] both apps launched; channels rejoining')
  await sleep(15000) // signaling + channel sync settle

  // A edits the shared recipe → sync traffic to B. (DOM clicks: this
  // harness's coordinate clicks are intermittently swallowed — same
  // lesson as proof-hubfail; the elements and handlers are the real ones.)
  const ev = (d, s) => d.executeScript('return eval(arguments[0])', [s])
  await (await A.$('button.recipe-card*=Hubfail Stew')).waitForExist({ timeout: 30000 })
  await ev(A, '[...document.querySelectorAll("button.recipe-card")].find(e => e.textContent.includes("Hubfail Stew"))?.click()')
  await (await A.$('[data-testid="recipe-title"]')).waitForExist({ timeout: 20000 })
  await ev(A, 'document.querySelector(\'[data-testid="edit-recipe"]\')?.click()')
  await (await A.$('[data-testid="field-title"]')).waitForExist({ timeout: 20000 })
  const stamp = new Date().toISOString().slice(11, 19)
  const newTitle = `Hubfail Stew audit ${stamp}`
  await (await A.$('[data-testid="field-title"]')).setValue(newTitle)
  await ev(A, 'document.querySelector(\'[data-testid="save-recipe"]\')?.click()')
  await (await A.$('[data-testid="recipe-title"]')).waitForExist({ timeout: 20000 })
  console.log(`[audit-session] A edited recipe → "${newTitle}"`)

  // B receives it via the friend channel.
  const evB = (s) => B.executeScript('return eval(arguments[0])', [s])
  const got = await waitFor(B, async () => {
    const panel = await B.$('[data-testid="friends-panel"]')
    if (!(await panel.isExisting())) {
      const open = await B.$('[data-testid="friends-open"]')
      if (await open.isExisting()) {
        await evB('document.querySelector(\'[data-testid="friends-open"]\')?.click()')
      } else {
        const back = await B.$('[data-testid="back-to-list"]')
        if (await back.isExisting()) await back.click().catch(() => {})
        return null
      }
    }
    const items = await B.$$('[data-testid="shelf-item"]')
    for (const item of items) {
      if ((await item.getText()).includes(newTitle)) return item
    }
    const close = await B.$('[data-testid="close-friends"]')
    if (await close.isExisting()) {
      await evB('document.querySelector(\'[data-testid="close-friends"]\')?.click()')
    }
    return null
  }, 180000)
  console.log(`[audit-session] B received the edit via friend channel: ${!!got}`)
  if (!got) throw new Error('B never received the audit edit')

  // B queries the active hub's AppView via Discover.
  const close = await B.$('[data-testid="close-friends"]')
  if (await close.isExisting()) {
    await evB('document.querySelector(\'[data-testid="close-friends"]\')?.click()')
  }
  await sleep(500)
  await evB('document.querySelector(\'[data-testid="open-discover"]\')?.click()')
  await (await B.$('[data-testid="discover-panel"]')).waitForExist({ timeout: 20000 })
  await (await B.$('[data-testid="field-discover-q"]')).setValue('Hubfail')
  await evB('document.querySelector(\'[data-testid="discover-search"]\')?.click()')
  await sleep(5000) // the AppView query happens even with zero results
  console.log('[audit-session] B ran a Discover search against the AppView')

  await sleep(10000) // trailing sync/keepalive window
  await A.deleteSession().catch(() => {})
  await B.deleteSession().catch(() => {})
  console.log('[audit-session] done')
}

main().catch((e) => {
  console.error('audit-session error:', e)
  process.exit(1)
})
