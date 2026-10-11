#!/usr/bin/env node
// Decisive test: fresh navigation, probe load-event firing and SW registration
// with zero manual intervention.
const CDP_PORT = process.argv[2] || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  if (!page) throw new Error('no page target')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString())
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    }
  }
  await new Promise((res, rej) => {
    ws.onopen = res
    ws.onerror = rej
  })
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve)
      ws.send(JSON.stringify({ id, method, params }))
    })
  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    })
    if (r.result && r.result.exceptionDetails) {
      throw new Error('eval: ' + JSON.stringify(r.result.exceptionDetails).slice(0, 300))
    }
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  // Install a load probe BEFORE navigating via a blank page.
  await send('Page.navigate', { url: 'about:blank' })
  await sleep(1500)
  await evaluate(`window.__loadFired = false; window.addEventListener('load', () => { window.__loadFired = true })`)
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/' })
  await sleep(10000)

  const probe = await evaluate(`({
    loadFired: window.__loadFired,
    readyState: document.readyState,
    appRendered: !!document.querySelector('[data-testid="recipe-list"]'),
  })`)
  console.log('probe:', JSON.stringify(probe))
  const regs = await evaluate(`navigator.serviceWorker.getRegistrations().then((rs) => rs.length)`)
  console.log('registrations (app auto):', regs)
  const ctl = await evaluate(`String(!!navigator.serviceWorker.controller)`)
  console.log('controller:', ctl)
  ws.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
