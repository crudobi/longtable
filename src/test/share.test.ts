/**
 * P2P share unit tests (H3 + M-C): room authentication + payload
 * validation. y-webrtc is mocked with a recording fake — no network.
 * Covers: the provider is constructed WITH the share secret as its
 * password for new shares and WITHOUT one for legacy payloads; re-sharing
 * is idempotent (same secret); a payload whose room disagrees with its
 * recipe id is rejected; a malformed snapshot is rejected at parse time;
 * and joinShare refuses to merge a snapshot into an existing non-empty
 * local doc that is not already this share's doc (fresh-GUID binding).
 */
import 'fake-indexeddb/auto'
import * as Y from 'yjs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const providerCalls = vi.hoisted(() => [] as Array<{ room: string; opts: Record<string, unknown> }>)

vi.mock('y-webrtc', () => ({
  WebrtcProvider: class {
    awareness = { getStates: () => new Map() }
    constructor(room: string, _doc: unknown, opts: Record<string, unknown>) {
      providerCalls.push({ room, opts })
    }
    destroy() {}
  },
}))

import {
  destroyAllShareProviders,
  getShare,
  joinShare,
  parseSharePayload,
  roomForRecipe,
  shareRecipe,
  type SharePayload,
} from '../p2p/share'
import { getOrCreateDoc, getRepo } from '../store/repo'
import { RECIPE_MAP } from '../store/recipes'

function mkLocalStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k: string) => (m.has(k) ? (m.get(k) as string) : null),
    setItem: (k: string, v: string) => void m.set(k, String(v)),
    removeItem: (k: string) => void m.delete(k),
    clear: () => m.clear(),
    key: () => null,
    length: 0,
  } as Storage
}

const b64 = (u8: Uint8Array) => Buffer.from(u8).toString('base64')

/** Create (or load) a doc and give it a title, the way a real recipe doc looks. */
async function seedDoc(id: string, title: string): Promise<Y.Doc> {
  const doc = await getOrCreateDoc(getRepo(), id)
  doc.transact(() => {
    doc.getMap(RECIPE_MAP).set('title', title)
  })
  return doc
}

/**
 * Snapshot of a recipe as the HOST would embed it: built on a standalone
 * doc (never loaded through the repo), so the repo-side doc under the
 * same id stays untouched — exactly like a guest device receiving bytes
 * from elsewhere.
 */
async function snapshotOf(id: string, title: string): Promise<string> {
  const src = new Y.Doc({ guid: id })
  src.transact(() => {
    src.getMap(RECIPE_MAP).set('title', title)
  })
  const snap = b64(Y.encodeStateAsUpdate(src))
  src.destroy()
  return snap
}

let n = 0
const freshId = () => `share-test-${++n}-${Date.now()}`

beforeEach(() => {
  ;(globalThis as { localStorage?: Storage }).localStorage = mkLocalStorage()
  providerCalls.length = 0
})

afterEach(() => {
  destroyAllShareProviders()
  delete (globalThis as { localStorage?: Storage }).localStorage
})

describe('share room authentication', () => {
  it('shareRecipe mints a secret, passes it to the provider, and puts it in the payload', async () => {
    const id = freshId()
    await seedDoc(id, 'Hosted')
    const payload = await shareRecipe(id, 'Hosted', 'wss://test:4444')
    expect(payload.secret).toBeTruthy()
    expect(typeof payload.secret).toBe('string')
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].room).toBe(roomForRecipe(id))
    expect(providerCalls[0].opts.password).toBe(payload.secret)
    expect(getShare(id)?.secret).toBe(payload.secret)
  })

  it('re-sharing is idempotent: the same secret comes back', async () => {
    const id = freshId()
    await seedDoc(id, 'Hosted')
    const p1 = await shareRecipe(id, 'Hosted', 'wss://test:4444')
    const p2 = await shareRecipe(id, 'Hosted', 'wss://test:4444')
    expect(p2.secret).toBe(p1.secret)
  })

  it('joinShare connects with the payload secret and stores it', async () => {
    const srcId = freshId()
    const snapshot = await snapshotOf(srcId, 'From Host')
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(srcId),
      signaling: 'wss://test:4444',
      recipeId: srcId,
      title: 'From Host',
      snapshot,
      secret: 'c2hhcmUtc2VjcmV0',
    }
    await joinShare(payload)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].opts.password).toBe('c2hhcmUtc2VjcmV0')
    expect(getShare(srcId)?.secret).toBe('c2hhcmUtc2VjcmV0')
    const doc = await getOrCreateDoc(getRepo(), srcId)
    expect(doc.getMap(RECIPE_MAP).get('title')).toBe('From Host')
  })

  it('legacy payload (no secret) joins passwordless, exactly as before', async () => {
    const srcId = freshId()
    const snapshot = await snapshotOf(srcId, 'Legacy')
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(srcId),
      signaling: 'wss://test:4444',
      recipeId: srcId,
      title: 'Legacy',
      snapshot,
    }
    await joinShare(payload)
    expect(providerCalls).toHaveLength(1)
    expect(providerCalls[0].opts.password).toBeUndefined()
    expect(getShare(srcId)?.secret).toBeUndefined()
  })
})

describe('parseSharePayload validation', () => {
  it('round-trips a current payload (with secret)', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'RT')
    const payload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'RT',
      snapshot,
      secret: 'c2VjcmV0',
    }
    const parsed = parseSharePayload(JSON.stringify(payload))
    expect(parsed.recipeId).toBe(id)
    expect(parsed.secret).toBe('c2VjcmV0')
  })

  it('rejects a payload whose room does not match its recipe id', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Forged')
    const payload = {
      v: 1,
      room: 'longtable-share-someone-elses-recipe',
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Forged',
      snapshot,
      secret: 'c2VjcmV0',
    }
    expect(() => parseSharePayload(JSON.stringify(payload))).toThrow()
  })

  it('rejects a snapshot that is not base64, and one that is not a Yjs update', () => {
    const id = freshId()
    const base = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'X',
    }
    expect(() =>
      parseSharePayload(JSON.stringify({ ...base, snapshot: '!!!not-base64!!!' })),
    ).toThrow()
    expect(() =>
      parseSharePayload(
        JSON.stringify({ ...base, snapshot: b64(new Uint8Array([9, 8, 7, 6, 5, 4, 3, 2, 1])) }),
      ),
    ).toThrow()
  })

  it('accepts a legacy payload with no secret field', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Old')
    const parsed = parseSharePayload(
      JSON.stringify({
        v: 1,
        room: roomForRecipe(id),
        signaling: 'wss://test:4444',
        recipeId: id,
        title: 'Old',
        snapshot,
      }),
    )
    expect(parsed.secret).toBeUndefined()
  })

  it('rejects an unknown top-level envelope key (Sec L3)', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Extra')
    const payload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Extra',
      snapshot,
      secret: 'c2VjcmV0',
      admin: true,
    }
    expect(() => parseSharePayload(JSON.stringify(payload))).toThrow(
      /not a valid Longtable share invitation/,
    )
  })

  it('rejects a snapshot whose recipe map carries an unknown key (Sec L3)', async () => {
    const id = freshId()
    // A crafted snapshot smuggling a field no recipe this app writes.
    const src = new Y.Doc({ guid: id })
    src.transact(() => {
      const map = src.getMap(RECIPE_MAP)
      map.set('title', 'Crafted')
      map.set('isAdmin', true)
    })
    const snapshot = b64(Y.encodeStateAsUpdate(src))
    src.destroy()
    const payload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Crafted',
      snapshot,
      secret: 'c2VjcmV0',
    }
    // parseSharePayload wraps every snapshot-validation failure in
    // the generic invitation error (pre-existing S9 behavior — the
    // scanner is told the code is invalid, not which check failed);
    // the specific 'unknown recipe field' message surfaces at
    // joinShare, which validates the real doc directly (see below).
    expect(() => parseSharePayload(JSON.stringify(payload))).toThrow(
      /not a valid Longtable share invitation/,
    )
  })

  it('accepts a snapshot carrying every legitimate recipe key (Sec L3 control)', async () => {
    const id = freshId()
    const src = new Y.Doc({ guid: id })
    src.transact(() => {
      const map = src.getMap(RECIPE_MAP)
      map.set('schemaVersion', 1)
      map.set('title', 'Full')
      map.set('visibility', 'friends-only')
      map.set('createdAt', '2026-01-01T00:00:00.000Z')
      map.set('updatedAt', '2026-01-02T00:00:00.000Z')
      const ing = new Y.Array()
      ing.push(['tomatoes', 'salt'])
      map.set('ingredients', ing)
    })
    const snapshot = b64(Y.encodeStateAsUpdate(src))
    src.destroy()
    const parsed = parseSharePayload(
      JSON.stringify({
        v: 1,
        room: roomForRecipe(id),
        signaling: 'wss://test:4444',
        recipeId: id,
        title: 'Full',
        snapshot,
        secret: 'c2VjcmV0',
      }),
    )
    expect(parsed.recipeId).toBe(id)
  })
})

describe('joinShare fresh-GUID binding', () => {
  it('refuses to merge a snapshot into an existing non-empty doc that is not this share’s', async () => {
    const id = freshId()
    // The victim's own locally authored recipe lives under this id.
    await seedDoc(id, 'My Own Recipe')
    // A crafted payload (e.g. naming a published recipe's id) tries to
    // merge attacker content into it.
    const foreignId = freshId()
    const snapshot = await snapshotOf(foreignId, 'Attacker Content')
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Attacker Content',
      snapshot,
      secret: 'YXR0YWNrZXI',
    }
    await expect(joinShare(payload)).rejects.toThrow(/already have/)
    const doc = await getOrCreateDoc(getRepo(), id)
    expect(doc.getMap(RECIPE_MAP).get('title')).toBe('My Own Recipe')
    expect(providerCalls).toHaveLength(0) // never joined the attacker's room
  })

  it('re-joining a share this device already joined is allowed', async () => {
    const id = freshId()
    const snapshot = await snapshotOf(id, 'Shared Once')
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Shared Once',
      snapshot,
      secret: 'c2VjcmV0',
    }
    await joinShare(payload)
    // Second join of the SAME share: the doc now has content, but the
    // share record marks it as this share's doc — must not refuse.
    await expect(joinShare(payload)).resolves.toBeUndefined()
  })

  it('rejects a snapshot with an unknown recipe key at apply time (Sec L3)', async () => {
    const id = freshId()
    // joinShare re-validates the snapshot on the real doc, so a
    // crafted code that somehow bypassed parse-time validation still
    // cannot smuggle an unknown field into the guest's store — and
    // the room is never joined.
    const src = new Y.Doc({ guid: id })
    src.transact(() => {
      const map = src.getMap(RECIPE_MAP)
      map.set('title', 'Crafted')
      map.set('isAdmin', true)
    })
    const snapshot = b64(Y.encodeStateAsUpdate(src))
    src.destroy()
    const payload: SharePayload = {
      v: 1,
      room: roomForRecipe(id),
      signaling: 'wss://test:4444',
      recipeId: id,
      title: 'Crafted',
      snapshot,
      secret: 'c2VjcmV0',
    }
    await expect(joinShare(payload)).rejects.toThrow(/unknown recipe field/)
    expect(providerCalls).toHaveLength(0) // never joined the attacker's room
    expect(getShare(id)).toBeUndefined()
    // And nothing was left behind in the guest's store: the crafted
    // snapshot was validated on a scratch doc, never applied here.
    const doc = await getOrCreateDoc(getRepo(), id)
    expect(doc.getMap(RECIPE_MAP).size).toBe(0)
  })
})
