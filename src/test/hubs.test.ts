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
  LEGACY_HUB_HASHES,
  LEGACY_HUB_HASHES_V0,
  addHub,
  getActiveHub,
  getIceServers,
  getSignalingUrls,
  legacyMatchHash,
  listHubs,
  migrateLegacyDefaultHub,
  removeHub,
  setActiveHub,
  updateHub,
  type HubConfig,
  type HubRegistry,
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

  it('legacyMatchHash matches the FNV-1a-64 test vectors', () => {
    expect(legacyMatchHash('')).toBe('cbf29ce484222325')
    expect(legacyMatchHash('a')).toBe('af63dc4c8601ec8c')
    expect(legacyMatchHash('local-dev')).not.toBe(LEGACY_HUB_HASHES.id)
  })

  it('migrates a persisted legacy default-hub entry in place', () => {
    // The migration matches on digests, so the test exercises the same
    // code path with synthetic values and their digests -- the real
    // legacy literals appear nowhere in this file.
    const oldId = 'old-test-hub'
    const oldName = 'Old Test Hub'
    const oldCred = 'old-test-credential'
    const hashes = {
      id: legacyMatchHash(oldId),
      name: legacyMatchHash(oldName),
      credential: legacyMatchHash(oldCred),
    }
    const legacy: HubConfig = {
      ...DEFAULT_HUB,
      id: oldId,
      name: oldName,
      turnCredential: oldCred,
    }
    const reg: HubRegistry = { hubs: [legacy], activeId: oldId }
    expect(migrateLegacyDefaultHub(reg, hashes)).toBe(true)
    expect(reg.hubs).toHaveLength(1)
    const migrated = reg.hubs[0]
    expect(migrated.id).toBe(DEFAULT_HUB.id)
    expect(migrated.name).toBe(DEFAULT_HUB.name)
    // The burned credential is gone (test builds inject no replacement).
    expect(migrated.turnCredential).toBeUndefined()
    expect(reg.activeId).toBe(DEFAULT_HUB.id)
    // Everything else about the entry is preserved.
    expect(migrated.signalingUrl).toBe(legacy.signalingUrl)
    expect(migrated.appviewUrl).toBe(legacy.appviewUrl)
    expect(migrated.turnUrl).toBe(legacy.turnUrl)
  })

  it('legacy migration keeps a user-renamed hub name', () => {
    const oldId = 'old-test-hub'
    const hashes = {
      id: legacyMatchHash(oldId),
      name: legacyMatchHash('Old Test Hub'),
      credential: legacyMatchHash('old-test-credential'),
    }
    // S23: a renamed legacy hub proves itself by its credential — the
    // name no longer matches, so the burned credential is the evidence
    // the migration requires. A real renamed legacy entry still carries
    // the burned credential (nothing else rotates it).
    const reg: HubRegistry = {
      hubs: [
        {
          ...DEFAULT_HUB,
          id: oldId,
          name: 'My kitchen hub',
          turnCredential: 'old-test-credential',
        },
      ],
      activeId: oldId,
    }
    expect(migrateLegacyDefaultHub(reg, hashes)).toBe(true)
    expect(reg.hubs[0].id).toBe(DEFAULT_HUB.id)
    expect(reg.hubs[0].name).toBe('My kitchen hub')
    expect(reg.hubs[0].turnCredential).toBeUndefined()
    expect(reg.activeId).toBe(DEFAULT_HUB.id)
  })

  it('legacy migration refuses an id-digest-only collision (S23)', () => {
    // The id digest matches the legacy set, but neither the name nor
    // the credential does: this is a user hub that happens to share
    // the 64-bit id digest, not the legacy hub. It must be left
    // exactly as configured — id, name, credential, and activeId.
    const oldId = 'old-test-hub'
    const hashes = {
      id: legacyMatchHash(oldId),
      name: legacyMatchHash('Old Test Hub'),
      credential: legacyMatchHash('old-test-credential'),
    }
    const reg: HubRegistry = {
      hubs: [
        {
          ...DEFAULT_HUB,
          id: oldId,
          name: 'My kitchen hub',
          turnCredential: 'my-own-credential',
        },
      ],
      activeId: oldId,
    }
    expect(migrateLegacyDefaultHub(reg, hashes)).toBe(false)
    expect(reg.hubs[0].id).toBe(oldId)
    expect(reg.hubs[0].name).toBe('My kitchen hub')
    expect(reg.hubs[0].turnCredential).toBe('my-own-credential')
    expect(reg.activeId).toBe(oldId)
  })

  it('legacy migration leaves non-legacy entries untouched', () => {
    const reg: HubRegistry = {
      hubs: [{ ...DEFAULT_HUB, id: 'hub-something-else', name: 'Other' }],
      activeId: 'hub-something-else',
    }
    expect(migrateLegacyDefaultHub(reg)).toBe(false)
    expect(reg.hubs[0].id).toBe('hub-something-else')
    expect(reg.activeId).toBe('hub-something-else')
  })

  it('legacy migration matches a second digest set for one release (V0)', () => {
    // Production matches both the corrected digests and the 440c8ac
    // set for one release; synthetic values stand in for both. The
    // name/credential checks use the set the id matched, so a mixed
    // entry keeps the fields the matched set does not recognize.
    const oldId = 'old-v0-hub'
    const oldName = 'Old V0 Hub'
    const oldCred = 'old-v0-credential'
    const v0Hashes = {
      id: legacyMatchHash(oldId),
      name: legacyMatchHash(oldName),
      credential: legacyMatchHash(oldCred),
    }
    const correctedHashes = {
      id: legacyMatchHash('old-corrected-hub'),
      name: legacyMatchHash('Old Corrected Hub'),
      credential: legacyMatchHash('old-corrected-credential'),
    }
    const reg: HubRegistry = {
      hubs: [{ ...DEFAULT_HUB, id: oldId, name: oldName, turnCredential: oldCred }],
      activeId: oldId,
    }
    expect(migrateLegacyDefaultHub(reg, [correctedHashes, v0Hashes])).toBe(true)
    expect(reg.hubs[0].id).toBe(DEFAULT_HUB.id)
    expect(reg.hubs[0].name).toBe(DEFAULT_HUB.name)
    expect(reg.hubs[0].turnCredential).toBeUndefined()
    expect(reg.activeId).toBe(DEFAULT_HUB.id)
    // The two committed sets are distinct: the V0 id digest must not
    // equal the corrected one.
    expect(LEGACY_HUB_HASHES_V0.id).not.toBe(LEGACY_HUB_HASHES.id)
    expect(LEGACY_HUB_HASHES_V0.name).not.toBe(LEGACY_HUB_HASHES.name)
    expect(LEGACY_HUB_HASHES_V0.credential).not.toBe(LEGACY_HUB_HASHES.credential)
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
      { urls: 'turn:10.0.2.2:3478', username: 'longtable' },
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
