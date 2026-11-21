/**
 * leaveShare proof (reliability H1 = integrity H7, plus integrity H-N2).
 *
 * The old unit-test shape could not catch this bug: recipes.test.ts's
 * delete test passes because no provider is ever attached. This file
 * attaches REAL y-webrtc providers (no vi.mock) and exercises the REAL
 * flows — performDeleteFlow, applyVisibilityFlow, rejoinShares — against
 * a REAL second device and the REAL signaling server:
 *
 *   - host: this thread, running the production store + share code
 *     (createRecipe / shareRecipe / performDeleteFlow /
 *     applyVisibilityFlow / rejoinShares) on the getRepo() singleton.
 *   - guest: a worker thread (leaveshare-guest.mjs) running a real
 *     WebrtcProvider on a real Y.Doc with the same guid — a genuine
 *     second device holding the recipe. Host and guest sync over
 *     BroadcastChannel, the same transport y-webrtc uses between browser
 *     tabs; the doc updates flowing there are real CRDT sync, not a stub.
 *   - signaling: the repo's own signaling/server.mjs on a local port.
 *     Providers point at it from the start (its URL is the share's
 *     signaling URL), but the server itself is only STARTED once the
 *     guest has synced over BroadcastChannel — node has no WebRTC, so a
 *     signaling announce that arrives before the BroadcastChannel peerId
 *     is known makes y-webrtc construct a SimplePeer and throw
 *     ("No WebRTC support", an unhandled rejection; reproduced 2/3 runs
 *     with the server already running). Browsers and emulators have
 *     WebRTC, so this is a node-test-environment sequencing constraint,
 *     not a production behavior. Starting the server late keeps the
 *     proof deterministic while the providers genuinely subscribe to it
 *     (asserted via /health topics >= 1).
 *
 * Awareness is NOT used as a peer signal: nothing in the app ever sets
 * local awareness state, so awareness holds only self on both sides
 * (pre-existing; peerCount() reads 0 even while synced). Sync is proven
 * by doc convergence — titles flowing both ways — before every
 * leave/delete assertion, so "no further updates" is never vacuous.
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { spawn, type ChildProcess } from 'node:child_process'
import net from 'node:net'
import { fileURLToPath } from 'node:url'
import { Worker } from 'node:worker_threads'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  destroyAllShareProviders,
  getShare,
  hasShareProvider,
  joinShare,
  leaveShare,
  rejoinShares,
  roomForRecipe,
  shareRecipe,
  type SharePayload,
} from '../p2p/share'
import { applyVisibilityFlow, performDeleteFlow } from '../recipeFlows'
import { docUrl, getOrCreateDoc, getRepo, resetRepoForTests } from '../store/repo'
import {
  createRecipe,
  deleteRecipe,
  getOrCreateIndex,
  getRecipe,
  listRecipes,
  memoryStore,
  RECIPE_MAP,
  updateRecipe,
} from '../store/recipes'
import { HUBS_KEY } from '../hubs/hubs'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(
  fn: () => T | Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<NonNullable<T>> {
  const t0 = Date.now()
  for (;;) {
    const v = await fn()
    if (v !== null && v !== undefined && v !== false) return v as NonNullable<T>
    if (Date.now() - t0 > timeoutMs) throw new Error(`timed out waiting for ${label}`)
    await sleep(100)
  }
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = net.createServer()
    s.once('error', reject)
    s.listen(0, '127.0.0.1', () => {
      const port = (s.address() as net.AddressInfo).port
      s.close(() => resolve(port))
    })
  })
}

function mkLocalStorage(seed: Record<string, string> = {}): Storage {
  const m = new Map<string, string>(Object.entries(seed))
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

/** Hub registry containing ONLY the given signaling URL (hermetic: no
 * default-hub endpoints are ever attempted). */
function hubSeed(signalingUrl: string): Record<string, string> {
  return {
    [HUBS_KEY]: JSON.stringify({
      hubs: [
        {
          id: 'local-test',
          name: 'Local test',
          signalingUrl,
          appviewUrl: 'http://127.0.0.1:9/',
          pdsUrl: 'http://127.0.0.1:9/',
        },
      ],
      activeId: 'local-test',
    }),
  }
}

type GuestMsg = {
  type: 'synced' | 'update' | 'title' | 'destroyed'
  title?: string | null
}

/** The second device: a worker thread running a real provider + doc. */
class Guest {
  private worker: Worker
  private msgs: GuestMsg[] = []
  readonly errors: unknown[] = []

  constructor(opts: {
    room: string
    secret: string | undefined
    signaling: string[]
    recipeId: string
    snapshot: string
  }) {
    this.worker = new Worker(new URL('./leaveshare-guest.mjs', import.meta.url), {
      workerData: opts,
    })
    this.worker.on('message', (m: GuestMsg) => this.msgs.push(m))
    this.worker.on('error', (e) => this.errors.push(e))
  }

  /** Wait until the guest's doc has a title (snapshot or live sync). */
  async waitSynced(timeoutMs = 15000): Promise<string> {
    const m = await waitFor(
      () => this.msgs.find((x) => x.type === 'synced' && x.title) ?? null,
      timeoutMs,
      'guest synced',
    )
    return m.title as string
  }

  /** Wait until the guest observes the given title. */
  async waitTitle(title: string, timeoutMs = 8000): Promise<void> {
    await waitFor(
      () =>
        this.msgs.find(
          (x) => (x.type === 'update' || x.type === 'synced') && x.title === title,
        ) ?? null,
      timeoutMs,
      `guest sees title ${JSON.stringify(title)}`,
    )
  }

  /** Current guest title, read on demand (index-gated, so a reply to an
   * older request can never satisfy a newer read). */
  async titleNow(): Promise<string | null> {
    const n = this.msgs.length
    this.worker.postMessage({ type: 'getTitle' })
    const m = await waitFor(
      () => this.msgs.slice(n).find((x) => x.type === 'title') ?? null,
      5000,
      'guest title reply',
    )
    return m.title ?? null
  }

  edit(title: string): void {
    this.worker.postMessage({ type: 'edit', title })
  }

  async destroy(): Promise<void> {
    const n = this.msgs.length
    this.worker.postMessage({ type: 'destroy' })
    await waitFor(
      () => this.msgs.slice(n).find((x) => x.type === 'destroyed') ?? null,
      5000,
      'guest destroyed',
    )
  }

  async terminate(): Promise<void> {
    await this.worker.terminate()
  }
}

/** Title of the host's cached doc, if it is loaded at all — no creation,
 * so a missing doc reads as "not resurrected", not as an empty shell.
 * (getRecipe would CREATE the doc, so it must never be used for this.) */
function hostDocTitle(id: string): string | undefined {
  const entry = getRepo().docs.get(id)
  const t = entry?.doc.getMap(RECIPE_MAP).get('title')
  return typeof t === 'string' ? t : undefined
}

let n = 0
const freshId = () => `leaveshare-test-${++n}-${Date.now()}`

async function snapshotOf(id: string, title: string): Promise<string> {
  const src = new Y.Doc({ guid: id })
  src.transact(() => {
    src.getMap(RECIPE_MAP).set('title', title)
  })
  const snap = Buffer.from(Y.encodeStateAsUpdate(src)).toString('base64')
  src.destroy()
  return snap
}

async function seedDoc(id: string, title: string): Promise<void> {
  const doc = await getOrCreateDoc(getRepo(), id)
  doc.transact(() => {
    doc.getMap(RECIPE_MAP).set('title', title)
  })
}

// --- per-test harness state -------------------------------------------------

let guest: Guest | null = null
let server: ChildProcess | null = null
let serverPort = 0
let unhandled: unknown[] = []
const onUnhandled = (e: unknown) => {
  unhandled.push(e)
}

function seedHubs(signalingUrl: string): void {
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage(
    hubSeed(signalingUrl),
  )
}

beforeEach(() => {
  // Dead default URL until a guest test picks a real port (keeps the
  // non-guest tests hermetic: no default-hub endpoints are attempted).
  seedHubs('ws://127.0.0.1:9')
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
})

afterEach(async () => {
  process.off('unhandledRejection', onUnhandled)
  if (guest) {
    await guest.destroy().catch(() => undefined)
    await guest.terminate().catch(() => undefined)
    guest = null
  }
  if (server) {
    const s = server
    server = null
    s.kill('SIGTERM')
    await Promise.race([new Promise((r) => s.once('exit', r)), sleep(2000)])
    if (s.exitCode === null) s.kill('SIGKILL')
  }
  destroyAllShareProviders()
  resetRepoForTests()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

/**
 * Start the REAL signaling server on the already-chosen port (late: only
 * after the guest has synced over BroadcastChannel — see the file header).
 * Asserts the providers genuinely subscribe (health topics >= 1).
 */
async function attachSignaling(): Promise<void> {
  const serverPath = fileURLToPath(new URL('../../signaling/server.mjs', import.meta.url))
  server = spawn('node', [serverPath], {
    cwd: fileURLToPath(new URL('../..', import.meta.url)),
    env: {
      ...process.env,
      PORT: String(serverPort),
      TLS_CERT: '/nonexistent',
      TLS_KEY: '/nonexistent',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const health = await waitFor(
    async () => {
      try {
        const r = await fetch(`http://127.0.0.1:${serverPort}/health`)
        const j = (await r.json()) as { ok?: boolean; topics?: number }
        return j.ok && (j.topics ?? 0) >= 1 ? j : null
      } catch {
        return null
      }
    },
    15000,
    'signaling server health with a subscribed topic',
  )
  expect(health.topics ?? 0).toBeGreaterThanOrEqual(1)
  // Let the subscribe + announce round settle; any no-WebRTC throw from
  // the announce race would surface here as an unhandled rejection
  // before the test proceeds.
  await sleep(1000)
  expect(unhandled).toEqual([])
}

/**
 * Share a recipe with a live guest peer and prove sync both ways, so the
 * leave/delete assertions that follow are never vacuous: if sync were
 * broken, this helper fails first.
 */
async function shareWithGuest(title: string): Promise<{
  id: string
  index: Awaited<ReturnType<typeof getOrCreateIndex>>
  signalingUrl: string
}> {
  serverPort = await freePort()
  const signalingUrl = `ws://127.0.0.1:${serverPort}`
  seedHubs(signalingUrl)
  const repo = getRepo()
  const index = await getOrCreateIndex(repo, memoryStore())
  const summary = await createRecipe(repo, index, {
    title,
    ingredients: [],
    steps: [],
    photos: [],
  })
  const id = summary.id
  const payload = await shareRecipe(id, title, signalingUrl)
  guest = new Guest({
    room: roomForRecipe(id),
    secret: payload.secret,
    signaling: [signalingUrl],
    recipeId: id,
    snapshot: payload.snapshot,
  })
  expect(await guest.waitSynced()).toBe(title)
  // Guest -> host: proves the guest's provider delivers into the host doc.
  guest.edit(`${title} (guest)`)
  await waitFor(
    () => hostDocTitle(id) === `${title} (guest)`,
    8000,
    'host sees guest edit',
  )
  // Host -> guest: proves the host's provider delivers into the guest doc,
  // and restores the original title for the assertions that follow.
  await updateRecipe(repo, index, id, { title })
  await guest.waitTitle(title)
  expect(hostDocTitle(id)).toBe(title)
  return { id, index, signalingUrl }
}

describe('leaveShare: delete', () => {
  it('delete via performDeleteFlow leaves no provider, no record, and rejoinShares does not resurrect the doc', async () => {
    const { id, index } = await shareWithGuest('Doomed Soup')
    await attachSignaling()
    const repo = getRepo()

    // Sanity: live sync still works with signaling connected.
    await updateRecipe(repo, index, id, { title: 'Doomed Soup v2' })
    await guest!.waitTitle('Doomed Soup v2')

    // THE DELETE, via the real flow.
    await performDeleteFlow(id, { identity: null })
    expect(getShare(id)).toBeUndefined()
    expect(hasShareProvider(id)).toBe(false)
    expect((await listRecipes(index)).map((s) => s.id)).not.toContain(id)
    expect(hostDocTitle(id)).toBeUndefined()
    expect(getRepo().docs.has(id)).toBe(false)

    // Relaunch: rejoinShares must not bring the room back.
    await rejoinShares()
    expect(hasShareProvider(id)).toBe(false)
    expect(getShare(id)).toBeUndefined()

    // The guest still holds the doc and edits it — the host must not
    // resurrect. (On the pre-fix code the provider + record survive the
    // delete, rejoinShares re-attaches, and this edit flows back.)
    guest!.edit('Doomed Soup RESURRECTED?')
    await sleep(1500)
    expect(hostDocTitle(id)).toBeUndefined()
    expect(getRepo().docs.has(id)).toBe(false)
    expect(await guest!.titleNow()).toBe('Doomed Soup RESURRECTED?')
    expect(unhandled).toEqual([])
    expect(guest!.errors).toEqual([])
  }, 120_000)
})

describe('leaveShare: visibility', () => {
  it.each([
    { tier: 'private', visibility: undefined },
    { tier: 'friends-only', visibility: 'friends-only' },
  ] as const)(
    'flip to $tier via applyVisibilityFlow destroys the provider and the room gets no further updates',
    async ({ tier, visibility }) => {
      const { id, index } = await shareWithGuest('Narrowed Soup')
      await attachSignaling()
      const repo = getRepo()
      const recipe = await getRecipe(repo, docUrl(id))
      expect(recipe).not.toBeNull()

      // THE FLIP, via the real flow.
      await applyVisibilityFlow(id, recipe!, tier, { identity: null })
      expect(getShare(id)).toBeUndefined()
      expect(hasShareProvider(id)).toBe(false)
      // The recipe itself survives, at the new tier.
      const after = await getRecipe(repo, docUrl(id))
      expect(after?.title).toBe('Narrowed Soup')
      expect(after?.visibility).toBe(visibility)

      // Host edits must not reach the guest anymore.
      await updateRecipe(repo, index, id, { title: 'Narrowed Soup v2' })
      await sleep(1500)
      expect(await guest!.titleNow()).toBe('Narrowed Soup')
      // Guest edits must not reach the host anymore.
      guest!.edit('Guest Edit After Narrowing')
      await sleep(1500)
      expect(hostDocTitle(id)).toBe('Narrowed Soup v2')
      // And a relaunch must not revive the room either.
      await rejoinShares()
      expect(hasShareProvider(id)).toBe(false)
      expect(unhandled).toEqual([])
      expect(guest!.errors).toEqual([])
    },
    120_000,
  )
})

describe('leaveShare: join/leave round-trip (real joinShare)', () => {
  it('joinShare then leaveShare: record and provider go away and rejoinShares stays quiet', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Joined')
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'ws://127.0.0.1:9',
      recipeId: id,
      title: 'Joined',
      snapshot,
      secret: 'c2VjcmV0LWpvaW4=',
    }
    await joinShare(payload)
    expect(getShare(id)?.role).toBe('guest')
    expect(hasShareProvider(id)).toBe(true)
    leaveShare(id)
    expect(getShare(id)).toBeUndefined()
    expect(hasShareProvider(id)).toBe(false)
    await rejoinShares()
    expect(hasShareProvider(id)).toBe(false)
    // Idempotent, and a no-op for recipes that were never shared.
    expect(() => leaveShare(id)).not.toThrow()
    expect(() => leaveShare(`never-shared-${Date.now()}`)).not.toThrow()
    expect(unhandled).toEqual([])
  }, 30_000)

  it('rejoinShares drops a share record whose recipe is gone from the index (pre-fix orphan)', async () => {
    const repo = getRepo()
    const index = await getOrCreateIndex(repo, memoryStore())
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Orphan')
    await joinShare({
      v: 1,
      room: roomForRecipe(id),
      signaling: 'ws://127.0.0.1:9',
      recipeId: id,
      title: 'Orphan',
      snapshot,
      secret: 'c2VjcmV0LW9ycGhhbg==',
    })
    expect(getShare(id)).toBeDefined()
    // The pre-fix delete primitive: removes the index entry + doc, but
    // never touched the share record — exactly the orphan the old code
    // left behind in localStorage.
    await deleteRecipe(repo, index, id)
    expect(getShare(id)).toBeDefined()
    await rejoinShares()
    expect(getShare(id)).toBeUndefined()
    expect(hasShareProvider(id)).toBe(false)
    expect(unhandled).toEqual([])
  }, 30_000)
})

describe('leaveShare: legacy-secret upgrade surfaced at share time', () => {
  it('re-sharing a legacy (passwordless) share mints a secret and flags the upgrade; re-sharing again is stable', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Legacy')
    await joinShare({
      v: 1,
      room: roomForRecipe(id),
      signaling: 'ws://127.0.0.1:9',
      recipeId: id,
      title: 'Legacy',
      snapshot,
    })
    expect(getShare(id)?.secret).toBeUndefined()
    const p1 = await shareRecipe(id, 'Legacy', 'ws://127.0.0.1:9')
    expect(p1.secret).toBeTruthy()
    expect(p1.upgradedFromLegacy).toBe(true)
    const p2 = await shareRecipe(id, 'Legacy', 'ws://127.0.0.1:9')
    expect(p2.secret).toBe(p1.secret)
    expect(p2.upgradedFromLegacy).toBeUndefined()
    // A fresh share is not an upgrade.
    const id2 = freshId()
    await seedDoc(id2, 'Fresh')
    const p3 = await shareRecipe(id2, 'Fresh', 'ws://127.0.0.1:9')
    expect(p3.secret).toBeTruthy()
    expect(p3.upgradedFromLegacy).toBeUndefined()
    expect(unhandled).toEqual([])
  }, 30_000)
})
