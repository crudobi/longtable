#!/usr/bin/env node
// Timing probe: attach load listeners at various points, see which fire.
const CDP_PORT = process.argv[2] || '9333'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function main() {
  const targets = await (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json()
  const page = targets.find((t) => t.type === 'page')
  const ws = new WebSocket(page.webSocketDebuggerUrl)
  let id = 0
  const pending = new Map()
  const loadEvents = []
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data.toString())
    if (m.id !== undefined && pending.has(m.id)) {
      pending.get(m.id)(m)
      pending.delete(m.id)
    } else if (m.method === 'Page.loadEventFired') {
      loadEvents.push(Date.now())
      console.log('[cdp] Page.loadEventFired')
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) =>
        a.value !== undefined ? String(a.value) : a.description || a.type,
      )
      console.log('[console]', ...args)
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
    return r.result && r.result.result ? r.result.result.value : undefined
  }

  await send('Page.enable')
  await send('Runtime.enable')
  const t0 = Date.now()
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/' })
  // Attach a load listener ASAP after navigation returns.
  const early = await evaluate(`new Promise((resolve) => {
    if (document.readyState === 'complete') { resolve('already-complete'); return }
    window.addEventListener('load', () => resolve('load-fired-after-attach'), { once: true })
    setTimeout(() => resolve('timeout-readyState=' + document.readyState), 15000)
  })`)
  console.log(`early listener result after ${Date.now() - t0}ms:`, early)
  const regs = await evaluate(`navigator.serviceWorker.getRegistrations().then((rs) => rs.length)`)
  console.log('registrations:', regs)
  ws.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
