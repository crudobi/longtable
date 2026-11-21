/**
 * Startup background-failure notices (Rel L6).
 *
 * Several startup jobs run in the background — secret migration,
 * old-cookbook recovery, index cleanup, identity setup, friends
 * imports/sweeps, share rejoin, the localhost API — and every one of
 * them used to fail console-only: the app looked fine while a whole
 * subsystem was quietly down. Each failure now also appends a
 * plain-language notice to App's non-blocking startup banner (the
 * banner dismisses; the app keeps working; nothing is fatal).
 *
 * This module is pure (kind -> sentence + deduped append) so the
 * wording is unit-tested without rendering App. The wiring — which
 * catch reports which kind — lives in App.tsx.
 */

export type StartupFailureKind =
  | 'secrets-migration'
  | 'automerge-migration'
  | 'index-cleanup'
  | 'identity-setup'
  | 'received-shares-import'
  | 'friends-sweep'
  | 'rejoin-shares'
  | 'local-api-start'

const NOTICES: Record<StartupFailureKind, string> = {
  'secrets-migration':
    "Your saved secrets couldn't be checked at startup — they still work from this device's storage, but a damaged entry may not have been moved to secure storage yet.",
  'automerge-migration':
    "The old-cookbook recovery couldn't run at startup — your current recipes are unaffected, and it will try again next launch.",
  'index-cleanup':
    'The startup recipe-list check couldn’t run — a recipe left over from an interrupted save may still be listed.',
  'identity-setup':
    'Your device identity couldn’t be loaded at startup — sharing and publishing are unavailable until you restart the app.',
  'received-shares-import':
    "Recipes shared with you couldn't be checked at startup — open Friends to refresh them.",
  'friends-sweep':
    "Shared recipes couldn't be re-checked at startup — a friend may still see an older version until the next refresh.",
  'rejoin-shares':
    "Shared recipes couldn't be reconnected at startup — peers will reconnect when you open a shared recipe.",
  'local-api-start':
    "The on-device API couldn't start — third-party apps on this device can't reach Longtable right now.",
}

/** Plain-language notice for a startup background failure. */
export function startupNotice(kind: StartupFailureKind): string {
  return NOTICES[kind]
}

/** Append a notice, deduped — the same background job must not stack the banner. */
export function addStartupNotice(notices: string[], kind: StartupFailureKind): string[] {
  const msg = NOTICES[kind]
  return notices.includes(msg) ? notices : [...notices, msg]
}
