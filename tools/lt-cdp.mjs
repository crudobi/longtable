#!/usr/bin/env node
/**
 * CDP-driven browser session for the Longtable zero-network check.
 *
 * Usage: node lt-cdp.mjs <cdp-port> <mode>
 *   mode=first  — load the app, create a recipe via the real UI (proves
 *                 IndexedDB works), report service-worker + IndexedDB state.
 *   mode=second — load the app again in the same profile, report the visible
 *                 recipes (proves SW serving + IndexedDB persistence).
 *
 * Requires Chromium running headless with --remote-debugging-port=<cdp-port>.
 * Uses only Node 24 built-ins (global fetch + WebSocket).
 */
const CDP_PORT = process.argv[2]
const MODE = process.argv[3]
const APP_URL = 'http://127.0.0.1:8765/'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)
  const targets = await res.json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target found')

  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let nextId = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data.toString())
    if (msg.id !== undefined && pending.has(msg.id)) {
      pending.get(msg.id)(msg)
      pending.delete(msg.id)
    }
  }
  await new Promise((resolve, reject) => {
    ws.onopen = resolve
    ws.onerror = () => reject(new Error('websocket failed'))
  })

  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = ++nextId
      pending.set(id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result && r.result.exceptionDetails) {
      throw new Error(
        'evaluate exception: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 400),
      )
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  const waitFor = (selector, timeoutMs, what) =>
    `new Promise((resolve, reject) => {
      const t0 = Date.now();
      const tick = () => {
        if (document.querySelector('${selector}')) { resolve(1); return }
        if (Date.now() - t0 > ${timeoutMs}) { reject(new Error('${what} did not appear')); return }
        setTimeout(tick, 200)
      }
      tick()
    })`

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: APP_URL })
  await evaluate(waitFor('[data-testid="recipe-list"]', 20000, 'recipe list'))

  const swControlled = await evaluate('String(!!navigator.serviceWorker.controller)')

  if (MODE === 'first') {
    // Drive the real UI: new recipe -> fill form -> save -> detail view.
    await evaluate(`document.querySelector('[data-testid="new-recipe"]').click()`)
    await evaluate(waitFor('[data-testid="recipe-form"]', 10000, 'recipe form'))
    // React controlled inputs: set via the native value setter + input event.
    const setVal = `(sel, v) => {
      const el = document.querySelector(sel)
      const proto = el instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, v)
      el.dispatchEvent(new Event('input', { bubbles: true }))
      el.dispatchEvent(new Event('change', { bubbles: true }))
    }`
    await evaluate(`(${setVal})('[data-testid="field-title"]', 'CDP Test Pancakes')`)
    await evaluate(`(${setVal})('[data-testid="field-prep"]', '10')`)
    await evaluate(`(${setVal})('[data-testid="field-cook"]', '15')`)
    await evaluate(`(${setVal})('[data-testid="field-ingredient"]', '2 cups flour')`)
    await evaluate(`document.querySelector('[data-testid="add-ingredient"]').click()`)
    await evaluate(`(${setVal})('[data-testid="field-step"]', 'Mix and cook.')`)
    await evaluate(`document.querySelector('[data-testid="add-step"]').click()`)
    await evaluate(`document.querySelector('[data-testid="save-recipe"]').click()`)
    await evaluate(waitFor('[data-testid="recipe-detail"]', 10000, 'recipe detail'))
    const title = await evaluate(
      `document.querySelector('[data-testid="recipe-title"]').textContent`,
    )
    const dbs = await evaluate(`indexedDB.databases().then((ds) => ds.map((d) => d.name))`)
    // Let the service worker finish installing + precaching before we close.
    await sleep(6000)
    console.log(
      JSON.stringify({ mode: MODE, swControlled, createdTitle: title, indexedDBs: dbs }),
    )
  } else {
    const items = await evaluate(
      `Array.from(document.querySelectorAll('[data-testid="recipe-item"]')).map((e) => e.textContent.trim())`,
    )
    console.log(JSON.stringify({ mode: MODE, swControlled, visibleRecipes: items }))
  }
  ws.close()
}

main().catch((e) => {
  console.error('CDP FAILED:', e.message)
  process.exit(1)
})
