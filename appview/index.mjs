/**
 * Longtable hub AppView — entry point.
 *
 * Env:
 *   APPVIEW_PORT  listen port            (default 3210)
 *   APPVIEW_DB    SQLite index path      (default ./appview.db)
 *   PDS_URL       local PDS base URL     (default http://localhost:2583)
 *   PLC_URL       local PLC base URL     (default http://localhost:2582)
 *
 * Run it in tmux:  tmux new -s lt-appview -d 'cd appview && npm start'
 */
import { createAppView } from './server.mjs'

const port = Number(process.env.APPVIEW_PORT ?? 3210)
const app = createAppView({
  dbPath: process.env.APPVIEW_DB ?? './appview.db',
  pdsUrl: process.env.PDS_URL ?? 'http://localhost:2583',
  plcUrl: process.env.PLC_URL ?? 'http://localhost:2582',
})

await app.listen(port)
console.info(`[appview] listening on :${port} (db=${process.env.APPVIEW_DB ?? './appview.db'})`)
app.ingestor.startFirehose()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.info(`[appview] ${sig}, shutting down`)
    await app.close()
    process.exit(0)
  })
}
