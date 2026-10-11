#!/usr/bin/env node
// Fresh-load console capture: navigate, print all console messages, report SW state.
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
    } else if (m.method === 'Runtime.consoleAPICalled') {
      const args = (m.params.args || []).map((a) =>
        a.value !== undefined ? String(a.value) : (a.description || a.type),
      )
      console.log('[console.' + m.params.type + ']', ...args)
    } else if (m.method === 'Runtime.exceptionThrown') {
      console.log('[pageerror]', (m.params.exceptionDetails.text || '') +
        ' ' + (m.params.exceptionDetails.exception?.description || '').slice(0, 200))
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
  await send('Page.navigate', { url: 'http://127.0.0.1:8765/' })
  await evaluate(`new Promise((resolve, reject) => {
    const t0 = Date.now()
    const tick = () => {
      if (document.querySelector('[data-testid="recipe-list"]')) return resolve(1)
      if (Date.now() - t0 > 20000) return reject(new Error('no render'))
      setTimeout(tick, 250)
    }
    tick()
  })`)
  console.log('rendered; waiting 12s...')
  await sleep(12000)
  const regs = await evaluate(`navigator.serviceWorker.getRegistrations().then((rs) =>
    rs.map((r) => ({ state: r.active ? r.active.state : 'none' })))`)
  console.log('registrations:', JSON.stringify(regs))
  console.log('controller:', await evaluate(`String(!!navigator.serviceWorker.controller)`))
  ws.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
