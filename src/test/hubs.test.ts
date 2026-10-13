/**
 * Hub registry unit tests (Phase 4).
 *
 * Covers: default seeding, CRUD, active-hub selection, ICE server
 * construction, the rendezvous signaling list (failover), corrupt-storage
 * fallback, and the zero-loss invariant — hub operations never touch any
 * other localStorage keys (recipes/friends/shares/identity live elsewhere).
 */
import { describe, expect, it } from 'vitest'
import type { KeyValueStore } from '../identity/identity'
import {
  DEFAULT_HUB,
  HUBS_KEY,
  addHub,
  getActiveHub,
  getIceServers,
  getSignalingUrls,
  listHubs,
  removeHub,
  setActiveHub,
  updateHub,
  type HubConfig,
} from '../hubs/hubs'

function memKv(seed: Record<string, string> = {}): KeyValueStore & { map: Map<string, string> } {
  const map = new Map(Object.entries(seed))
  return {
    map,
    getItem: (k) => (map.has(k) ? map.get(k)! : null),
    setItem: (k, v) => {
      map.set(k, v)
    },
  }
}

const HUB_B = {
  name: 'Hub B',
  signalingUrl: 'wss://hub-b.example:4444',
  stunUrl: 'stun:hub-b.example:3478',
  turnUrl: 'turn:hub-b.example:3478',
  turnUsername: 'u',
  turnCredential: 'p',
  appviewUrl: 'https://hub-b.example:3211',
  pdsUrl: 'https://hub-b.example:2584',
}

describe('hub registry', () => {
  it('seeds the built-in default hub on first run', () => {
    const kv = memKv()
    const hubs = listHubs(kv)
    expect(hubs).toHaveLength(1)
    expect(hubs[0].id).toBe(DEFAULT_HUB.id)
    expect(getActiveHub(kv).signalingUrl).toBe(DEFAULT_HUB.signalingUrl)
  })

  it('add + setActive + remove round-trip', () => {
    const kv = memKv()
    const b = addHub(HUB_B, kv)
    expect(listHubs(kv).map((h) => h.id)).toContain(b.id)
    // adding does not steal active status
    expect(getActiveHub(kv).id).toBe(DEFAULT_HUB.id)
    setActiveHub(b.id, kv)
    expect(getActiveHub(kv).id).toBe(b.id)
    // active hub sorts first
    expect(listHubs(kv)[0].id).toBe(b.id)
    removeHub(b.id, kv)
    // removing the active hub falls back to the remaining one
    expect(getActiveHub(kv).id).toBe(DEFAULT_HUB.id)
    expect(listHubs(kv)).toHaveLength(1)
  })

  it('refuses to remove the last hub', () => {
    const kv = memKv()
    expect(() => removeHub(DEFAULT_HUB.id, kv)).toThrow(/last hub/)
  })

  it('updateHub patches fields, keeps id', () => {
    const kv = memKv()
    const b = addHub(HUB_B, kv)
    const next = updateHub(b.id, { name: 'Renamed' }, kv)
    expect(next.id).toBe(b.id)
    expect(next.name).toBe('Renamed')
  })

  it('falls back to the default hub on corrupt storage', () => {
    const kv = memKv({ [HUBS_KEY]: '{not json' })
    expect(getActiveHub(kv).id).toBe(DEFAULT_HUB.id)
    const kv2 = memKv({ [HUBS_KEY]: JSON.stringify({ hubs: [], activeId: 'x' }) })
    expect(getActiveHub(kv2).id).toBe(DEFAULT_HUB.id)
  })

  it('builds ICE servers from ALL hubs, primary first (TURN redundancy)', () => {
    const kv = memKv()
    const hubB = addHub({ ...HUB_B }, kv)
    // Primary = hub B: its STUN/TURN lead, the default hub's follow.
    expect(getIceServers(hubB, kv)).toEqual([
      { urls: 'stun:hub-b.example:3478' },
      { urls: 'turn:hub-b.example:3478', username: 'u', credential: 'p' },
      { urls: 'stun:10.0.2.2:3478' },
      { urls: 'turn:10.0.2.2:3478', username: 'longtable', credential: 'dev-turn-password' },
    ])
    // No primary: active hub first (the default hub is active here).
    expect(getIceServers(undefined, kv)[0]).toEqual({ urls: 'stun:10.0.2.2:3478' })
    // A primary with no TURN of its own still yields the other hubs' TURN:
    // a dead or TURN-less hub never strands a peer.
    const bare: HubConfig = { ...DEFAULT_HUB, id: 'bare', stunUrl: undefined, turnUrl: undefined }
    const fromBare = getIceServers(bare, kv)
    expect(fromBare).toContainEqual({
      urls: 'turn:hub-b.example:3478',
      username: 'u',
      credential: 'p',
    })
    // A registry whose only hub has no TURN yields nothing.
    const kv2 = memKv({
      [HUBS_KEY]: JSON.stringify({ hubs: [{ ...bare }], activeId: 'bare' }),
    })
    expect(getIceServers(undefined, kv2)).toEqual([])
  })

  it('rendezvous list: primary first, then all hubs, deduplicated', () => {
    const kv = memKv()
    const b = addHub(HUB_B, kv)
    const urls = getSignalingUrls('wss://invite.example:4444', kv)
    expect(urls[0]).toBe('wss://invite.example:4444')
    expect(urls).toContain(DEFAULT_HUB.signalingUrl)
    expect(urls).toContain(b.signalingUrl)
    expect(new Set(urls).size).toBe(urls.length)
    // primary equal to a hub URL is not duplicated
    const urls2 = getSignalingUrls(b.signalingUrl, kv)
    expect(urls2.filter((u) => u === b.signalingUrl)).toHaveLength(1)
  })

  it('zero-loss invariant: hub ops never touch other keys', () => {
    const kv = memKv({
      'longtable:shares': '[{"recipeId":"r1"}]',
      'longtable:friends': '[{"did":"did:key:zX"}]',
      'longtable:identity': '{"did":"did:key:zMe"}',
    })
    const b = addHub(HUB_B, kv)
    setActiveHub(b.id, kv)
    updateHub(b.id, { name: 'B2' }, kv)
    removeHub(b.id, kv)
    expect(kv.map.get('longtable:shares')).toBe('[{"recipeId":"r1"}]')
    expect(kv.map.get('longtable:friends')).toBe('[{"did":"did:key:zX"}]')
    expect(kv.map.get('longtable:identity')).toBe('{"did":"did:key:zMe"}')
  })
})
