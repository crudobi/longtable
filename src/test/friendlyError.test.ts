/**
 * friendlyError: transport failures become plain language; user-written
 * domain messages pass through; raw internals never reach the UI.
 */
import { describe, expect, it } from 'vitest'
import { friendlyError } from '../friendlyError'
import { AtprotoError } from '../public/atproto'
import { ImporterError } from '../importers/contract'
import { UrlImportError } from '../importers/urlImport'

describe('friendlyError', () => {
  it('maps an expired ATProto session to re-sign-in guidance', () => {
    const msg = friendlyError(new AtprotoError('ExpiredToken', 401, 'ExpiredToken'))
    expect(msg).toMatch(/sign-in has expired/)
  })

  it('maps bad credentials and missing records', () => {
    expect(
      friendlyError(new AtprotoError('Invalid identifier or password', 401, 'InvalidIdentifierOrPassword')),
    ).toMatch(/not accepted/)
    expect(friendlyError(new AtprotoError('RecordNotFound', 404, 'RecordNotFound'))).toMatch(
      /already have been removed/,
    )
    expect(friendlyError(new AtprotoError('boom', 503))).toMatch(/server hit a problem/)
  })

  it('maps fetch TypeErrors to a reachability sentence naming the target', () => {
    expect(friendlyError(new TypeError('Failed to fetch'), 'the discovery service')).toMatch(
      /Couldn't reach the discovery service/,
    )
  })

  it('passes through plain domain messages (importer, URL import, pairing)', () => {
    expect(friendlyError(new ImporterError('Mealie import: not valid JSON.'))).toBe(
      'Mealie import: not valid JSON.',
    )
    expect(friendlyError(new UrlImportError('network', 'Could not read that page.'))).toBe(
      'Could not read that page.',
    )
    expect(friendlyError(new Error('Pairing timed out — the other device never answered.'))).toBe(
      'Pairing timed out — the other device never answered.',
    )
  })

  it('replaces raw internals (stacks, JSON, HTTP codes) with the generic sentence', () => {
    const stacky = new Error('HTTP 500 at foo (http://x) \n    at Object.<anonymous> (a.mjs:1:1)')
    const msg = friendlyError(stacky)
    expect(msg).not.toMatch(/HTTP 500/)
    expect(msg).toMatch(/Nothing was changed/)
    expect(friendlyError('a string failure')).toMatch(/Nothing was changed/)
    expect(friendlyError(null)).toMatch(/Nothing was changed/)
  })

  it('maps storage failures to storage wording', () => {
    expect(friendlyError(new Error('QuotaExceededError: IndexedDB quota'))).toMatch(/storage/)
  })
})
