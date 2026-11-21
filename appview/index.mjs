/**
 * Longtable hub AppView — entry point.
 *
 * Env:
 *   APPVIEW_PORT  listen port            (default 3210)
 *   APPVIEW_DB    SQLite index path      (default ./appview.db)
 *   APPVIEW_MEDIA media cache dir        (default: <db dir>/media)
 *   PDS_URL       local PDS base URL     (default http://localhost:2583)
 *   PLC_URL       local PLC base URL     (default http://localhost:2582)
 *   APPVIEW_RECONCILE_INTERVAL_MS
 *                 periodic reconcile sweep interval in ms (default 3600000,
 *                 one hour; N1/S2 healing sweep — see ingest.mjs)
 *   APPVIEW_FIREHOSE_CURSOR
 *                 firehose cursor file (default <db dir>/firehose-cursor.json;
 *                 H3 — the AppView resumes the firehose from the last seen
 *                 commit seq instead of re-scanning from scratch)
 *
 * Run it in tmux:  tmux new -s lt-appview -d 'cd appview && npm start'
 */
import { createAppView } from './server.mjs'

const port = Number(process.env.APPVIEW_PORT ?? 3210)
const app = createAppView({
  dbPath: process.env.APPVIEW_DB ?? './appview.db',
  pdsUrl: process.env.PDS_URL ?? 'http://localhost:2583',
  plcUrl: process.env.PLC_URL ?? 'http://localhost:2582',
  mediaDir: process.env.APPVIEW_MEDIA || undefined,
  firehoseCursorPath: process.env.APPVIEW_FIREHOSE_CURSOR || undefined,
})

await app.listen(port)
console.info(`[appview] listening on :${port} (db=${process.env.APPVIEW_DB ?? './appview.db'})`)

// Startup reconcile (S2): re-verify every DID already in the index, so
// pre-C2 rows with NULL signature fields are backfilled (or swept, when
// the binding verifies-invalid / the record is gone) instead of being
// served unverified forever. Then the periodic sweep (N1) keeps healing
// bindings that were missing at startup without waiting for the
// author's next commit. Both run through the ingestor's serialized
// queue; the firehose stays the fast path for new commits.
const reconcileIntervalMs = Number(process.env.APPVIEW_RECONCILE_INTERVAL_MS ?? 3600000)
try {
  const results = await app.ingestor.reconcileAllDids()
  const swept = results.reduce(
    (acc, r) => ({ indexed: acc.indexed + (r.indexed ?? 0), deleted: acc.deleted + (r.deleted ?? 0) }),
    { indexed: 0, deleted: 0 },
  )
  console.info(
    `[appview] startup reconcile: ${results.length} DIDs, ${swept.indexed} indexed, ${swept.deleted} deleted`,
  )
} catch (err) {
  console.warn(`[appview] startup reconcile failed: ${err?.message ?? err}`)
}
app.ingestor.startPeriodicReconcile(reconcileIntervalMs)
app.ingestor.startFirehose()

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    console.info(`[appview] ${sig}, shutting down`)
    await app.close()
    process.exit(0)
  })
}
