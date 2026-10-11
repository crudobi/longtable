#!/usr/bin/env node
// Compare register() with and without updateViaCache on the live page.
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

  await send('Page.navigate', { url: 'http://127.0.0.1:8765/' })
  await sleep(6000)
  await evaluate(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))`)
  await sleep(1000)

  const plain = await evaluate(
    `navigator.serviceWorker.register('/sw.js').then(() => 'OK').catch((e) => 'FAIL ' + e.name + ': ' + e.message)`,
  )
  console.log('plain register:', plain)
  await evaluate(`navigator.serviceWorker.getRegistrations().then((rs) => Promise.all(rs.map((r) => r.unregister())))`)
  await sleep(1000)

  const withOpt = await evaluate(
    `navigator.serviceWorker.register('/sw.js', { updateViaCache: 'all' }).then(() => 'OK').catch((e) => 'FAIL ' + e.name + ': ' + e.message)`,
  )
  console.log('with updateViaCache:', withOpt)
  ws.close()
}

main().catch((e) => {
  console.error('FAILED:', e.message)
  process.exit(1)
})
