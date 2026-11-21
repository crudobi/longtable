/**
 * Client-side device-signature verification (review C2, client half).
 *
 * Mocked AppView responses are shaped exactly like the AppView's
 * rowToFull (appview/db.mjs): flat JSON, no $type, deviceDid /
 * deviceSignature / deviceKey top-level. Records are signed with
 * publish.ts (the same signer the app uses); the AppView fixtures at
 * appview/test/signed-fixtures.mjs are the cross-implementation reference
 * with an independent (node:crypto) signer and are intentionally NOT
 * reused here — these tests prove the client agrees with its own signer,
 * while the AppView's own tests prove the AppView agrees with the
 * independent signer. Do not modify AppView files for these tests.
 *
 * Fail-closed contract under test: fetchPublicRecipe throws
 * RecipeVerificationError (and returns nothing to display) for any
 * missing/invalid device field, any content tamper, or any signature
 * mismatch. Search summaries are returned unverified by design — see the
 * last test — because a summary carries no longtableId.
 */
import { describe, expect, it } from 'vitest'
import {
  fetchPublicRecipe,
  searchAppView,
  verifyPublicRecipe,
  RecipeVerificationError,
  type PublicRecipe,
} from '../public/discover'
import {
  buildRecipeRecord,
  signRecipeRecord,
  type PublishableRecipe,
} from '../public/publish'
import { identityFromSeed, type Identity } from '../identity/identity'
import { base64ToU8, u8ToBase64 } from '../identity/codec'

const ACCT = 'did:plc:accttest'
const SEED = new Uint8Array(32).fill(7)
const OTHER_SEED = new Uint8Array(32).fill(8)
const APPVIEW = 'http://localhost:3210'

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

/**
 * A valid served record in the AppView's /recipe/ shape: the flat
 * rowToFull JSON (no $type), signed by `identity` over the canonical
 * hash of exactly these fields.
 */
async function signedServedRecord(
  identity: Identity,
): Promise<Record<string, unknown>> {
  const unsigned = buildRecipeRecord(fixtureRecipe(), ACCT, ['bafyimg1'])
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

function mockAppView(served: unknown, status = 200) {
  return async (url: string): Promise<Response> => {
    expect(url).toContain('/recipe/')
    return new Response(JSON.stringify(served), {
      status,
      headers: { 'Content-Type': 'application/json' },
    })
  }
}

/** The verification reason of a rejected promise, or 'no-throw'. */
async function rejectionReason(p: Promise<unknown>): Promise<string> {
  try {
    await p
    return 'no-throw'
  } catch (e) {
    return e instanceof RecipeVerificationError
      ? e.reason
      : `other:${e instanceof Error ? e.message : String(e)}`
  }
}

describe('fetchPublicRecipe device-signature verification', () => {
  it('returns a valid device-signed record', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    const rec = await fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served))
    expect(rec.name).toBe('Tomato Soup')
    expect(rec.longtableId).toBe('recipe-1')
    expect(rec.deviceDid).toBe(identity.did)
    expect(rec.deviceKey).toBe(u8ToBase64(identity.publicKey))
    // Direct verification of the returned record also passes.
    await verifyPublicRecipe(rec, ACCT)
  })

  it('rejects a tampered name', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    served.name = 'Tomato Soup (HACKED)'
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('signature-invalid')
  })

  it('rejects tampered ingredients', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    served.ingredients = ['tomatoes', 'salt', 'arsenic']
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('signature-invalid')
  })

  it('rejects a tampered image CID (images are in the canonical hash)', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    const images = served.images as Array<{ ref: { $link: string } }>
    images[0].ref.$link = 'bafyforged'
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('signature-invalid')
  })

  it('rejects a tampered signature (one flipped byte, still canonical base64)', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    const sig = base64ToU8(served.deviceSignature as string)
    sig[0] ^= 1
    served.deviceSignature = u8ToBase64(sig)
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('signature-invalid')
  })

  it('rejects a missing deviceSignature', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    delete served.deviceSignature
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('missing-deviceSignature')
  })

  it('rejects a missing deviceDid', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    delete served.deviceDid
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('missing-deviceDid')
  })

  it('rejects a missing deviceKey', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    delete served.deviceKey
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('missing-deviceKey')
  })

  it('rejects a wrong deviceKey (another device key, deviceDid no longer matches it)', async () => {
    const identity = await identityFromSeed(SEED)
    const other = await identityFromSeed(OTHER_SEED)
    const served = await signedServedRecord(identity)
    served.deviceKey = u8ToBase64(other.publicKey)
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('deviceKey-mismatch')
  })

  it('rejects a mismatched longtableId (signature binds the id)', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    served.longtableId = 'recipe-2'
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('signature-invalid')
  })

  it('rejects a missing longtableId', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    delete served.longtableId
    expect(
      await rejectionReason(
        fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
      ),
    ).toBe('missing-longtableId')
  })

  it('throws RecipeVerificationError (not a generic error) on a bad record', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    served.name = 'Forged'
    await expect(
      fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served)),
    ).rejects.toBeInstanceOf(RecipeVerificationError)
    // And the UI copy is a plain short sentence (friendlyError passes it
    // through verbatim): no stack, no JSON blob, under 200 chars.
    try {
      await fetchPublicRecipe(APPVIEW, ACCT, 'recipe-1', mockAppView(served))
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(RecipeVerificationError)
      const msg = (e as Error).message
      expect(msg.length).toBeLessThan(200)
      expect(msg).toContain('device-signature check')
      expect(msg).not.toContain('\n')
    }
  })
})

describe('search summaries are unverified until opened', () => {
  it('carries the signature fields through but does not verify them', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    // A summary with a forged signature is still returned as a list item:
    // it carries no longtableId, so it cannot be verified here. The check
    // happens when the full record is opened (fetchPublicRecipe above).
    const summary = {
      did: ACCT,
      rkey: 'recipe-1',
      name: 'Tomato Soup',
      ingredients: ['tomatoes', 'salt'],
      tags: [],
      updatedAt: '2026-01-02T10:00:00.000Z',
      deviceDid: identity.did,
      deviceSignature: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA==',
      deviceKey: served.deviceKey,
    }
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ results: [summary] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const results = await searchAppView(APPVIEW, { q: 'soup' }, fetchFn)
    expect(results).toHaveLength(1)
    expect(results[0].deviceDid).toBe(identity.did)
    expect(results[0].deviceSignature).toBe(summary.deviceSignature)
    expect(results[0].deviceKey).toBe(summary.deviceKey)
    // No verification happened: a record that would fail verification is
    // still listed — the UI must not badge it as verified.
    await expect(
      verifyPublicRecipe(results[0] as unknown as PublicRecipe, ACCT),
    ).rejects.toBeInstanceOf(RecipeVerificationError)
  })
})

describe('search summaries carry longtableId (S10)', () => {
  it('searchAppView passes the summary longtableId through', async () => {
    const identity = await identityFromSeed(SEED)
    const served = await signedServedRecord(identity)
    const summary = {
      did: ACCT,
      rkey: 'recipe-1',
      name: 'Tomato Soup',
      ingredients: ['tomatoes', 'salt'],
      tags: [],
      updatedAt: '2026-01-02T10:00:00.000Z',
      longtableId: 'lt-recipe-1',
      deviceDid: identity.did,
      deviceSignature: served.deviceSignature,
      deviceKey: served.deviceKey,
    }
    const fetchFn = async (): Promise<Response> =>
      new Response(JSON.stringify({ results: [summary] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    const results = await searchAppView(APPVIEW, { q: 'soup' }, fetchFn)
    expect(results).toHaveLength(1)
    expect(results[0].longtableId).toBe('lt-recipe-1')
  })
})
