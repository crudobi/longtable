#!/usr/bin/env node
// Diagnose service-worker registration: capture console/page errors,
// report SW state, and attempt a manual registration.
const CDP_PORT = process.argv[2] || '9333'
const APP_URL = 'http://127.0.0.1:8765/'
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
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) => a.value ?? a.description ?? a.type)
      console.log('[console]', m.params.type, ...args)
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('[pageerror]', JSON.stringify(m.params.exceptionDetails).slice(0, 300))
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

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: APP_URL })
  await evaluate(`new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (document.querySelector('[data-testid="recipe-list"]')) return resolve(1)
      if (Date.now() - t0 > 20000) return reject(new Error('no render'))
      setTimeout(tick, 250)
    }
    tick()
  })`)
  console.log('app rendered; waiting 8s for load+registration...')
  await sleep(8000)

  const state = await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations()
    return {
      swInNavigator: 'serviceWorker' in navigator,
      registrations: regs.length,
      details: regs.map((r) => ({
        installing: !!r.installing,
        waiting: !!r.waiting,
        active: !!r.active,
        activeState: r.active ? r.active.state : null,
      })),
      controller: !!navigator.serviceWorker.controller,
    }
  })()`)
  console.log('SW state:', JSON.stringify(state))

  console.log('attempting manual registration...')
  const manual = await evaluate(
    `navigator.serviceWorker.register('/sw.js').then((r) => 'OK scope=' + r.scope).catch((e) => 'FAIL ' + e.name + ': ' + e.message)`,
  )
  console.log('manual:', manual)
  await sleep(6000)
  const after = await evaluate(`(async () => {
    const regs = await navigator.serviceWorker.getRegistrations()
    return regs.map((r) => ({ active: !!r.active, state: r.active ? r.active.state : null }))
  })()`)
  console.log('after manual:', JSON.stringify(after))
  console.log('controller now:', await evaluate('String(!!navigator.serviceWorker.controller)'))
  ws.close()
}

main().catch((e) => {
  console.error('DIAG FAILED:', e.message)
  process.exit(1)
})
