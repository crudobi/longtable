/**
 * Client-side binding fetch + verification (review S3 / H-N4).
 *
 * The AppView is no longer trusted for the device binding: the client
 * fetches the author's `kitchen.longtable.pubkey` record for the
 * recipe's deviceDid DIRECTLY from the author's PDS and verifies the
 * binding signature itself (src/public/binding.ts), then verifies the
 * recipe against the PDS-bound key. The tests that matter most here
 * are the forgeries: a hub that mints its own keypair, re-signs a
 * record, and serves a fully self-consistent forgery — exactly what
 * the old client accepted — must now be rejected, with the reason
 * naming the binding failure.
 *
 * All PDS/PLC traffic is mocked (a strict per-origin router: the
 * binding a PDS serves depends on which PDS is asked, and an unknown
 * URL throws — a test that fetches somewhere unexpected fails loudly
 * instead of passing on a permissive mock).
 */
import { describe, expect, it } from 'vitest'
import {
  fetchPublicRecipe,
  verifyPublicRecipe,
  RecipeVerificationError,
  type PublicRecipe,
} from '../public/discover'
import {
  BindingVerificationError,
  devicePinState,
  fetchAuthorBinding,
  recordDevicePin,
  resolveAuthorPdsUrl,
  verifyPubkeyBindingRecord,
} from '../public/binding'
import {
  buildRecipeRecord,
  pubkeyBindingMessage,
  pubkeyRkeyForDeviceDid,
  signRecipeRecord,
  type PublishableRecipe,
} from '../public/publish'
import { type AtprotoBlob } from '../public/atproto'
import { identityFromSeed, signDetached, type Identity } from '../identity/identity'
import { base64ToU8, u8ToBase64, utf8ToU8 } from '../identity/codec'
import { memoryStore } from '../store/recipes'

const ACCT = 'did:plc:accttest'
const SEED = new Uint8Array(32).fill(7)
const HUB_SEED = new Uint8Array(32).fill(21)
const OTHER_SEED = new Uint8Array(32).fill(8)
const APPVIEW = 'http://localhost:3210'
const PDS_URL = 'http://localhost:2583'
const OTHER_PDS_URL = 'http://localhost:2584'
const PLC_URL = 'https://plc.directory'

/** A real blob object (Int L4): buildRecipeRecord no longer fabricates one. */
function blob(cid: string): AtprotoBlob {
  return { $type: 'blob', ref: { $link: cid }, mimeType: 'image/png', size: 8 }
}

function fixtureRecipe(): PublishableRecipe {
  return {
    id: 'recipe-1',
    title: 'Tomato Soup',
    ingredients: ['tomatoes', 'salt'],
    steps: ['Chop', 'Simmer'],
    photos: [],
    prepMinutes: 5,
    cookMinutes: 25,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-02T10:00:00.000Z',
  }
}

/** The genuine per-device binding record for `identity`, signed by its device key. */
async function bindingRecordFor(identity: Identity): Promise<Record<string, unknown>> {
  const devicePublicKey = u8ToBase64(identity.publicKey)
  return {
    $type: 'kitchen.longtable.pubkey',
    deviceDid: identity.did,
    devicePublicKey,
    signature: u8ToBase64(
      await signDetached(
        identity,
        utf8ToU8(pubkeyBindingMessage(ACCT, identity.did, devicePublicKey)),
      ),
    ),
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}

/**
 * A valid served record in the AppView's /recipe/ shape, signed by
 * `identity` over the canonical hash of exactly these fields. With a
 * `nameOverride` the record is signed over the overridden name (so a
 * hub-minted forgery is self-consistent under the OLD checks — the
 * point of the forgery tests is that the new binding gate rejects it
 * anyway).
 */
async function signedServedRecord(
  identity: Identity,
  nameOverride?: string,
): Promise<Record<string, unknown>> {
  const unsigned = buildRecipeRecord(fixtureRecipe(), ACCT, [blob('bafyimg1')])
  if (nameOverride !== undefined) unsigned.name = nameOverride
  const deviceSignature = await signRecipeRecord(identity, ACCT, unsigned)
  return {
    uri: `at://${ACCT}/kitchen.longtable.recipe/recipe-1`,
    did: ACCT,
    rkey: 'recipe-1',
    name: unsigned.name,
    ingredients: [...unsigned.ingredients],
    instructions: [...unsigned.instructions],
    prepTimeMinutes: unsigned.prepTimeMinutes,
    cookTimeMinutes: unsigned.cookTimeMinutes,
    images: unsigned.images,
    longtableId: unsigned.longtableId,
    createdAt: unsigned.createdAt,
    updatedAt: unsigned.updatedAt,
    deviceDid: identity.did,
    deviceSignature,
    deviceKey: u8ToBase64(identity.publicKey),
  }
}

/** One PDS origin's binding table: rkey → binding record value. */
async function bindingsFor(identity: Identity): Promise<Map<string, unknown>> {
  const rkey = await pubkeyRkeyForDeviceDid(identity.did)
  return new Map([[rkey, await bindingRecordFor(identity)]])
}

interface MockStackOpts {
  served: unknown
  /** Per-origin binding tables (origin → rkey → binding value). */
  pdsBindings: Map<string, Map<string, unknown>>
  /** What the PLC DID doc names as the author's PDS (null = no PDS service). */
  plcPdsUrl?: string | null
  plcStatus?: number
  /** DID doc served for did:web:example.com (null = 404). */
  webDoc?: Record<string, unknown> | null
  /** When set, every getRecord answers with this HTTP status (e.g. 500). */
  getRecordStatus?: number
}

function mockStack(opts: MockStackOpts) {
  const calls: string[] = []
  const json = (obj: unknown, status = 200) =>
    new Response(JSON.stringify(obj), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  const fetchFn = async (url: string): Promise<Response> => {
    calls.push(url)
    if (url.includes('/recipe/')) return json(opts.served)
    if (url === 'https://example.com/.well-known/did.json') {
      if (!opts.webDoc) return json({ error: 'not found' }, 404)
      return json(opts.webDoc)
    }
    if (url.startsWith(`${PLC_URL}/`)) {
      if (opts.plcStatus !== undefined && opts.plcStatus !== 200) {
        return json({ error: 'not found' }, opts.plcStatus)
      }
      const services =
        opts.plcPdsUrl === null
          ? []
          : [
              {
                id: '#atproto_pds',
                type: 'AtprotoPersonalDataServer',
                serviceEndpoint: opts.plcPdsUrl ?? PDS_URL,
              },
            ]
      return json({ id: ACCT, service: services })
    }
    if (url.includes('com.atproto.repo.getRecord')) {
      if (opts.getRecordStatus !== undefined) {
        return json({ error: 'InternalError', message: 'boom' }, opts.getRecordStatus)
      }
      const u = new URL(url)
      const origin = u.origin
      const rkey = u.searchParams.get('rkey')
      const binding = rkey ? opts.pdsBindings.get(origin)?.get(rkey) : undefined
      if (!binding) {
        return json({ error: 'RecordNotFound', message: 'Record not found' }, 400)
      }
      return json({
        uri: `at://${ACCT}/kitchen.longtable.pubkey/${rkey}`,
        cid: 'bafybinding',
        value: binding,
      })
    }
    throw new Error(`unexpected fetch URL in mock: ${url}`)
  }
  return { fetchFn, calls }
}

/** The verification reason of a rejected promise, or 'no-throw'. */
async function rejectionReason(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'no-throw'
  } catch (e) {
    return e instanceof RecipeVerificationError
      ? e.reason
      : e instanceof BindingVerificationError
        ? e.reason
        : `other:${e instanceof Error ? e.message : String(e)}`
  }
}

describe('verifyPubkeyBindingRecord (client port of the AppView check)', () => {
  it('accepts a genuine binding', async () => {
    const identity = await identityFromSeed(SEED)
    const res = await verifyPubkeyBindingRecord(ACCT, await bindingRecordFor(identity))
    expect(res.ok).toBe(true)
    if (res.ok) {
      expect(res.deviceDid).toBe(identity.did)
      expect(res.devicePublicKey).toBe(u8ToBase64(identity.publicKey))
    }
  })

  it('rejects a binding signed by a different key', async () => {
    const identity = await identityFromSeed(SEED)
    const attacker = await identityFromSeed(OTHER_SEED)
    const binding = await bindingRecordFor(identity)
    binding.signature = u8ToBase64(
      await signDetached(
        attacker,
        utf8ToU8(
          pubkeyBindingMessage(ACCT, identity.did, u8ToBase64(identity.publicKey)),
        ),
      ),
    )
    const res = await verifyPubkeyBindingRecord(ACCT, binding)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('binding-signature-invalid')
  })

  it('rejects a binding whose key does not match its deviceDid', async () => {
    const identity = await identityFromSeed(SEED)
    const other = await identityFromSeed(OTHER_SEED)
    const binding = await bindingRecordFor(identity)
    binding.devicePublicKey = u8ToBase64(other.publicKey)
    // Re-sign over the mismatched key so only the key-match check can fire.
    binding.signature = u8ToBase64(
      await signDetached(
        identity,
        utf8ToU8(
          pubkeyBindingMessage(ACCT, identity.did, binding.devicePublicKey as string),
        ),
      ),
    )
    const res = await verifyPubkeyBindingRecord(ACCT, binding)
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('binding-key-mismatch')
  })

  it('rejects a binding for a different account DID', async () => {
    const identity = await identityFromSeed(SEED)
    const res = await verifyPubkeyBindingRecord(
      'did:plc:someoneelse',
      await bindingRecordFor(identity),
    )
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.reason).toBe('binding-signature-invalid')
  })

  it('rejects missing / malformed bindings without throwing', async () => {
    const missing = await verifyPubkeyBindingRecord(ACCT, null)
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.reason).toBe('missing-binding')
    expect((await verifyPubkeyBindingRecord(ACCT, {})).ok).toBe(false)
  })
})

describe('resolveAuthorPdsUrl', () => {
  it('resolves the PDS endpoint from a PLC DID document', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, await bindingsFor(identity)]]),
    })
    expect(await resolveAuthorPdsUrl(ACCT, fetchFn)).toBe(PDS_URL)
  })

  it('returns null when the DID document names no PDS', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, await bindingsFor(identity)]]),
      plcPdsUrl: null,
    })
    expect(await resolveAuthorPdsUrl(ACCT, fetchFn)).toBeNull()
  })

  it('returns null when the PLC lookup fails', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, await bindingsFor(identity)]]),
      plcStatus: 404,
    })
    expect(await resolveAuthorPdsUrl(ACCT, fetchFn)).toBeNull()
  })

  it('resolves a did:web DID via .well-known/did.json', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, await bindingsFor(identity)]]),
      webDoc: {
        id: 'did:web:example.com',
        service: [
          {
            id: '#atproto_pds',
            type: 'AtprotoPersonalDataServer',
            serviceEndpoint: PDS_URL,
          },
        ],
      },
    })
    expect(await resolveAuthorPdsUrl('did:web:example.com', fetchFn)).toBe(PDS_URL)
  })
})

describe('fetchAuthorBinding', () => {
  it('fetches and verifies the genuine binding via the hint PDS (no PLC call)', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn, calls } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, await bindingsFor(identity)]]),
    })
    const binding = await fetchAuthorBinding(ACCT, identity.did, fetchFn, {
      authorPdsUrl: PDS_URL,
    })
    expect(binding.deviceDid).toBe(identity.did)
    expect(binding.devicePublicKey).toBe(u8ToBase64(identity.publicKey))
    expect(calls.some((u) => u.startsWith(PLC_URL))).toBe(false)
    expect(calls.some((u) => u.includes('com.atproto.repo.getRecord'))).toBe(true)
  })

  it('falls back to PLC resolution when the hint PDS has no binding', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([
        [OTHER_PDS_URL, new Map()],
        [PDS_URL, await bindingsFor(identity)],
      ]),
    })
    const binding = await fetchAuthorBinding(ACCT, identity.did, fetchFn, {
      authorPdsUrl: OTHER_PDS_URL,
    })
    expect(binding.deviceDid).toBe(identity.did)
  })

  it('throws binding-not-found when no PDS has the binding', async () => {
    const identity = await identityFromSeed(SEED)
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([
        [OTHER_PDS_URL, new Map()],
        [PDS_URL, new Map()],
      ]),
    })
    await expect(
      fetchAuthorBinding(ACCT, identity.did, fetchFn, { authorPdsUrl: OTHER_PDS_URL }),
    ).rejects.toMatchObject({ reason: 'binding-not-found' })
    await expect(
      fetchAuthorBinding(ACCT, identity.did, fetchFn, { authorPdsUrl: OTHER_PDS_URL }),
    ).rejects.toBeInstanceOf(BindingVerificationError)
  })

  it('fails closed on a tampered binding and does NOT fall through to another PDS', async () => {
    const identity = await identityFromSeed(SEED)
    const tampered = await bindingRecordFor(identity)
    const sig = base64ToU8(tampered.signature as string)
    sig[0] ^= 1
    tampered.signature = u8ToBase64(sig)
    const tamperedMap = new Map([
      [await pubkeyRkeyForDeviceDid(identity.did), tampered],
    ])
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([
        // The hint PDS serves the TAMPERED binding; the PLC PDS has the genuine one.
        [OTHER_PDS_URL, tamperedMap],
        [PDS_URL, await bindingsFor(identity)],
      ]),
    })
    // A tampered binding is positive evidence, not a wrong address:
    // the genuine copy on the other PDS must NOT rescue it.
    await expect(
      fetchAuthorBinding(ACCT, identity.did, fetchFn, { authorPdsUrl: OTHER_PDS_URL }),
    ).rejects.toMatchObject({ reason: 'binding-signature-invalid' })
  })

  it('throws binding-deviceDid-mismatch when the PDS serves another device binding at this rkey', async () => {
    const identity = await identityFromSeed(SEED)
    const other = await identityFromSeed(OTHER_SEED)
    const wrongMap = new Map([
      [await pubkeyRkeyForDeviceDid(identity.did), await bindingRecordFor(other)],
    ])
    const { fetchFn } = mockStack({
      served: {},
      pdsBindings: new Map([[PDS_URL, wrongMap]]),
    })
    await expect(
      fetchAuthorBinding(ACCT, identity.did, fetchFn, { authorPdsUrl: PDS_URL }),
    ).rejects.toMatchObject({ reason: 'binding-deviceDid-mismatch' })
  })

  it('throws binding-unavailable when the PDS and PLC are both unreachable', async () => {
    const identity = await identityFromSeed(SEED)
    const failing: (url: string) => Promise<Response> = async () => {
      throw new Error('network down')
    }
    await expect(fetchAuthorBinding(ACCT, identity.did, failing)).rejects.toMatchObject({
      reason: 'binding-unavailable',
    })
  })
})

describe('fetchPublicRecipe hub-substitution (S3/H-N4)', () => {
  it('rejects a hub-minted forgery: hub key, hub signature, hub deviceDid — binding-not-found', async () => {
    const author = await identityFromSeed(SEED)
    const hub = await identityFromSeed(HUB_SEED)
    // The hub takes the genuine recipe, alters it, and re-signs with its
    // OWN key: served deviceDid/deviceKey/signature are fully
    // self-consistent, so the OLD client (verifyPublicRecipe alone)
    // accepts it — prove that first, so this test is not vacuous.
    const forged = await signedServedRecord(hub, 'Tomato Soup (HUB FORGERY)')
    await verifyPublicRecipe(forged as unknown as PublicRecipe, ACCT)
    // The PDS holds only the AUTHOR's binding — the hub device has none.
    const { fetchFn } = mockStack({
      served: forged,
      pdsBindings: new Map([[PDS_URL, await bindingsFor(author)]]),
    })
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
          authorPdsUrl: PDS_URL,
          pinStore: memoryStore(),
        }),
      ),
    ).toBe('binding-not-found')
  })

  it('rejects a hub serving the genuine deviceDid with its own key — deviceKey-mismatch', async () => {
    const author = await identityFromSeed(SEED)
    const hub = await identityFromSeed(HUB_SEED)
    // Genuine record + genuine signature, but the hub swaps in its own key.
    const served = await signedServedRecord(author)
    served.deviceKey = u8ToBase64(hub.publicKey)
    const { fetchFn } = mockStack({
      served,
      pdsBindings: new Map([[PDS_URL, await bindingsFor(author)]]),
    })
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
          authorPdsUrl: PDS_URL,
          pinStore: memoryStore(),
        }),
      ),
    ).toBe('deviceKey-mismatch')
  })

  it('rejects a tampered binding served by the PDS — binding-signature-invalid', async () => {
    const author = await identityFromSeed(SEED)
    const served = await signedServedRecord(author)
    const tampered = await bindingRecordFor(author)
    const sig = base64ToU8(tampered.signature as string)
    sig[0] ^= 1
    tampered.signature = u8ToBase64(sig)
    const { fetchFn } = mockStack({
      served,
      pdsBindings: new Map([
        [PDS_URL, new Map([[await pubkeyRkeyForDeviceDid(author.did), tampered]])],
      ]),
    })
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
          authorPdsUrl: PDS_URL,
          pinStore: memoryStore(),
        }),
      ),
    ).toBe('binding-signature-invalid')
  })

  it('accepts a genuine record and pins the device: new on first sight, known on second', async () => {
    const author = await identityFromSeed(SEED)
    const served = await signedServedRecord(author)
    const { fetchFn } = mockStack({
      served,
      pdsBindings: new Map([[PDS_URL, await bindingsFor(author)]]),
    })
    const pins = memoryStore()
    const first = await fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
      pinStore: pins,
    })
    expect(first.name).toBe('Tomato Soup')
    expect(first.bindingVerifiedVia).toBe('pds')
    expect(first.deviceSeenBefore).toBe(false)
    expect(devicePinState(pins, ACCT, author.did)).toBe('known')
    const second = await fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
      pinStore: pins,
    })
    expect(second.deviceSeenBefore).toBe(true)
  })

  it('falls back to PLC resolution when the hint PDS has no binding', async () => {
    const author = await identityFromSeed(SEED)
    const served = await signedServedRecord(author)
    const { fetchFn } = mockStack({
      served,
      pdsBindings: new Map([
        [OTHER_PDS_URL, new Map()],
        [PDS_URL, await bindingsFor(author)],
      ]),
    })
    const rec = await fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
      authorPdsUrl: OTHER_PDS_URL,
      pinStore: memoryStore(),
    })
    expect(rec.name).toBe('Tomato Soup')
    expect(rec.bindingVerifiedVia).toBe('pds')
  })

  it('fails closed when the binding cannot be fetched at all — binding-unavailable', async () => {
    const author = await identityFromSeed(SEED)
    const served = await signedServedRecord(author)
    // The hint PDS errors (500) and the PLC doc names no PDS, so there
    // is no second candidate and no binding — but the failure is a
    // fetch failure, not a proven absence: binding-unavailable, not
    // binding-not-found.
    const { fetchFn } = mockStack({
      served,
      pdsBindings: new Map(),
      plcPdsUrl: null,
      getRecordStatus: 500,
    })
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', fetchFn, {
          authorPdsUrl: OTHER_PDS_URL,
          pinStore: memoryStore(),
        }),
      ),
    ).toBe('binding-unavailable')
  })
})

describe('device pins (trust-on-first-use)', () => {
  it('new → record → known, scoped per author and device', async () => {
    const author = await identityFromSeed(SEED)
    const other = await identityFromSeed(OTHER_SEED)
    const pins = memoryStore()
    expect(devicePinState(pins, ACCT, author.did)).toBe('new')
    recordDevicePin(pins, ACCT, author.did)
    expect(devicePinState(pins, ACCT, author.did)).toBe('known')
    // Another device for the same author is still new; another author too.
    expect(devicePinState(pins, ACCT, other.did)).toBe('new')
    expect(devicePinState(pins, 'did:plc:someoneelse', author.did)).toBe('new')
    // Re-pinning is a no-op (first-seen timestamp is kept).
    recordDevicePin(pins, ACCT, author.did)
    expect(devicePinState(pins, ACCT, author.did)).toBe('known')
  })

  it('a corrupt pin store starts fresh instead of throwing', async () => {
    const author = await identityFromSeed(SEED)
    const pins = memoryStore()
    pins.setItem('longtable:pinned-devices:v1', '{not json')
    expect(devicePinState(pins, ACCT, author.did)).toBe('new')
    recordDevicePin(pins, ACCT, author.did)
    expect(devicePinState(pins, ACCT, author.did)).toBe('known')
  })
})
