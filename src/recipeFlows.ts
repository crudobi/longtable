/**
 * App-level recipe flows shared by the detail view and the localhost API
 * host: delete and visibility switching, with every sharing channel
 * (friends-only, public, P2P) moved together so no channel is left behind
 * when a recipe is deleted or narrowed.
 *
 * Extracted verbatim from App.tsx so the flows are unit-testable — the
 * component's performDelete / applyVisibility are one-liners over these,
 * and the localhost API host calls the same wrappers through refs, so an
 * API write takes exactly the UI's path.
 */
import { getRepo } from './store/repo'
import { deleteRecipe, getOrCreateIndex, updateRecipe } from './store/recipes'
import { leaveShare } from './p2p/share'
import { getRecipeKey } from './friends/shelf'
import { unshareRecipeEverywhere } from './friends/service'
import {
  ensurePubkeyBinding,
  getPublication,
  publishRecipe,
  unpublishRecipe,
} from './public/publish'
import {
  AtprotoClient,
  loadSession,
  saveSession,
  type PublicKv,
} from './public/atproto'
import { getRecipeProvenance, receivedRecipeRefusal } from './friends/provenance'
import { secretKv } from './secrets/secretStore'
import type { Identity, KeyValueStore } from './identity/identity'
import type { Recipe, VisibilityTier } from './types'

/**
 * Thrown by applyVisibilityFlow when a recipe is asked to go public without
 * a publishing session. The UI catches it and opens the publishing
 * settings instead of reporting an error; the localhost API host maps
 * it to a plain 422 (nothing is written in either case).
 */
export class VisibilitySessionError extends Error {
  constructor() {
    super('publishing sign-in needed')
    this.name = 'VisibilitySessionError'
  }
}

/**
 * Thrown by applyVisibilityFlow / performDeleteFlow when a recipe with a
 * live public record is narrowed or deleted while no publishing account
 * is signed in (H5, Wave 6B). The unpublish cannot even be attempted,
 * so the call is REFUSED before any mutation — the tier stays public,
 * the local copy stays, friends shares and the P2P room are untouched —
 * instead of landing a "now private / deleted" state with the public
 * copy still listed. The message names the lingering copy and says
 * what to do (sign in under Publishing, then retry). The UI catches
 * it and opens the publishing settings; the localhost API maps it to
 * a plain 422. Distinct from an ATTEMPTED unpublish that fails
 * (session present, PDS doesn't answer): that still throws from
 * unpublishRecipe on a flip, and on delete still deletes locally
 * with an H13 warning.
 */
export class PublicCopyLiveError extends Error {
  constructor() {
    super(
      'The public copy is still listed publicly — no publishing account ' +
        'is signed in on this device, so it can\'t be removed. Sign in ' +
        'under Publishing and try again; nothing was changed and the public ' +
        'copy stays live until then.',
    )
    this.name = 'PublicCopyLiveError'
  }
}

export interface FlowContext {
  identity: Identity | null
  /**
   * Publications registry override (tests only — production reads the
   * app's registry). Lets a test stage a public record without a
   * localStorage stub.
   */
  publicationsKv?: PublicKv
  /**
   * Called with the user-facing label of each remote copy that could not
   * be taken down ('the copies shared with friends', 'the public copy').
   */
  onRemoteProblem?: (label: string) => void
  /**
   * Store the provenance check reads (H4). Defaults to the app's
   * secret store — the same store importReceivedShares records
   * provenance into. Tests pass their injected store here.
   */
  kv?: KeyValueStore
}

/** The tombstone notice (H6/H13): friends' copies are recalled on sync, not instantly. */
export const TOMBSTONE_NOTICE =
  'Friends who already received this recipe will have their copies ' +
  'removed when their device next syncs; a copy on a device that never ' +
  'syncs again stays.'

// H5 (Wave 6B): the signed-out case no longer warns-and-proceeds —
// see PublicCopyLiveError above; there is no notice constant anymore.

/**
 * Int L14 — the friends-only → public notice. Going public does NOT
 * end the encrypted friends-only shares: the content is public now,
 * so the friends channel is redundant but harmless, and ending it
 * would DESTROY the friends' copies (the tombstone recall) for a
 * visibility widening, not a narrowing. That is the intended behavior
 * — and it is flagged, not silent: this notice goes into the warnings
 * the UI shows and the localhost API returns, so the user knows the
 * friends copies stay live and that ending one is a separate explicit
 * unshare. The vault's authorized-friend set is the signal: a friend
 * listed there holds a live share (the startup sweep republishes any
 * share whose publish failed, so the set and the live shares agree).
 */
export const FRIENDS_SHARES_LIVE_NOTICE =
  'This recipe stays shared with friends through their encrypted copies — ' +
  'they keep receiving updates there. Stop sharing it with a friend to end that copy.'

/** The Int L14 notice when this flip leaves friends shares live, else null. */
export function friendsSharesLiveNotice(
  id: string,
  recipe: Recipe,
  kv: KeyValueStore,
): string | null {
  if (recipe.visibility !== 'friends-only') return null
  const sharedWith = getRecipeKey(id, kv)?.friends ?? []
  return sharedWith.length > 0 ? FRIENDS_SHARES_LIVE_NOTICE : null
}

function publicationOf(id: string, ctx: FlowContext) {
  return ctx.publicationsKv ? getPublication(id, ctx.publicationsKv) : getPublication(id)
}

/**
 * The delete flow itself, without the confirmation prompt or UI
 * navigation: strip friends-only shares, remove the public record, leave
 * the P2P room, then delete locally. The local delete proceeds —
 * deleting here is the user's act — EXCEPT when the recipe has a live
 * public record and no publishing account is signed in (H5, Wave 6B):
 * then the delete is refused outright (PublicCopyLiveError) before
 * anything is touched, because the public copy could not be taken down
 * and the user must not be left believing it is gone. Otherwise the
 * flow RETURNS every warning in plain sentences (H13): remote copies
 * that could not be taken down, and the best-effort limits of the
 * tombstone recall. Nothing about a remote copy is ever swallowed
 * quietly.
 */
export async function performDeleteFlow(id: string, ctx: FlowContext): Promise<string[]> {
  const problems: string[] = []
  const warnings: string[] = []
  // H5 (Wave 6B): refuse before ANY mutation — unsharing friends or
  // leaving the P2P room first would leave a half-deleted recipe
  // behind a refused delete.
  if (publicationOf(id, ctx) && !loadSession()) throw new PublicCopyLiveError()
  // Strip friends-only shares of this recipe from friends' channels.
  // A successful unshare writes a signed tombstone per channel (H6);
  // the recall lands when each friend next syncs — that limit is itself
  // a warning the caller must surface, not a silent assumption.
  const idn = ctx.identity
  if (idn) {
    try {
      const sharedWith = await unshareRecipeEverywhere(id, idn)
      if (sharedWith.length > 0) warnings.push(TOMBSTONE_NOTICE)
    } catch (e) {
      console.warn('unshare failed', e)
      problems.push('the copies shared with friends')
      ctx.onRemoteProblem?.('the copies shared with friends')
    }
  }
  // If it was published publicly, remove the ATProto record first. A
  // session is guaranteed here: the signed-out case threw above.
  if (publicationOf(id, ctx)) {
    const session = loadSession()
    if (session) {
      await unpublishRecipe(new AtprotoClient(session.pdsUrl), session, id).catch(
        (e) => {
          console.warn('unpublish failed', e)
          problems.push('the public copy')
          ctx.onRemoteProblem?.('the public copy')
        },
      )
    }
  }
  // P2P (H1/H7): leave the room BEFORE the doc is wiped, so the provider
  // is dead and the share record gone while the doc still exists to
  // detach from. A local teardown failure must never block the delete,
  // so it is warned, not thrown.
  try {
    leaveShare(id)
  } catch (e) {
    console.warn('leave share failed', e)
  }
  const repo = getRepo()
  const index = await getOrCreateIndex(repo)
  await deleteRecipe(repo, index, id)
  if (problems.length > 0) {
    warnings.unshift(
      `Deleted from this device — but ${problems.join(' and ')} couldn't be taken down, because the other side didn't answer. ${problems.length === 1 ? 'It' : 'They'} may still be out there; your local copy is gone either way.`,
    )
  }
  return warnings
}

/**
 * Visibility switching — the real byte movement between tiers:
 *   → public:      requires an ATProto session (no session →
 *                  VisibilitySessionError; the UI wrapper opens the
 *                  publishing settings, the localhost API answers a
 *                  plain 422 — tier unchanged either way); ensure the
 *                  pubkey binding, publish the signed record to the
 *                  PDS, only then mark the recipe 'public'. The P2P room
 *                  is untouched: it is a separate channel the user
 *                  started, and the content is public anyway. The
 *                  encrypted friends-only shares are likewise left
 *                  live on purpose (Int L14) — ending them would
 *                  destroy friends' copies — and the flip returns a
 *                  warning saying so when any are live.
 *   → private:     unpublish the ATProto record first (if any); strip
 *                  friends-only shares everywhere (if friends-only);
 *                  leave the P2P room; then mark 'private'. With a live
 *                  public record and no session the flip is REFUSED
 *                  (PublicCopyLiveError, H5) — the tier stays public.
 *   → friends-only: unpublish the ATProto record first (if any); leave
 *                  the P2P room; mark 'friends-only'. Same refusal when
 *                  the public copy cannot be taken down for lack of a
 *                  session. (Choosing friends and publishing the
 *                  encrypted shares is the friend picker's job — the UI
 *                  wrapper opens it after this runs.)
 * Returns the plain-language warnings (H13) — the tombstone recall
 * limit on a private flip, the friends-shares-live notice on a public
 * flip. An unpublish that is ATTEMPTED and fails still throws (the
 * caller maps it to a 502), so a warning here never means "failed
 * silently".
 */
export async function applyVisibilityFlow(
  id: string,
  recipe: Recipe,
  tier: VisibilityTier,
  ctx: FlowContext,
): Promise<string[]> {
  const repo = getRepo()
  const index = await getOrCreateIndex(repo)
  const idn = ctx.identity
  const publication = publicationOf(id, ctx)
  const warnings: string[] = []
  const unpublishIfNeeded = async () => {
    if (!publication) return
    const session = loadSession()
    if (!session) {
      // H5 (Wave 6B): refuse — the tier must not change while the
      // public copy stays live. Thrown before any mutation in the
      // caller, so nothing has moved when this lands.
      throw new PublicCopyLiveError()
    }
    const client = new AtprotoClient(session.pdsUrl, {
      onSessionRefresh: (s) => saveSession(s),
    })
    await unpublishRecipe(client, session, id)
  }
  // P2P (H-N2): narrowing to private or friends-only leaves the plaintext
  // room — QR guests would otherwise keep receiving live edits forever.
  // A local teardown failure must never block the tier change, so it is
  // warned, not thrown.
  const leaveP2PIfNeeded = () => {
    try {
      leaveShare(id)
    } catch (e) {
      console.warn('leave share failed', e)
    }
  }

  if (tier === 'public') {
    // H4: a recipe received from a friend is not this device's to
    // publish — checked before any session or network step, so the
    // refusal is the same for the UI and the localhost API.
    const provenance = getRecipeProvenance(id, ctx.kv ?? secretKv)
    if (provenance) throw new Error(receivedRecipeRefusal(provenance))
    const session = loadSession()
    if (!session || !idn) throw new VisibilitySessionError()
    const client = new AtprotoClient(session.pdsUrl, {
      onSessionRefresh: (s) => saveSession(s),
    })
    await ensurePubkeyBinding(client, session, idn)
    await publishRecipe(client, session, idn, { ...recipe, id })
    await updateRecipe(repo, index, id, { visibility: 'public' })
    // Int L14: the friends shares stay live on purpose (see
    // FRIENDS_SHARES_LIVE_NOTICE) — flag it in the returned warnings
    // (UI + localhost API) rather than silently keeping them.
    const liveNotice = friendsSharesLiveNotice(id, recipe, ctx.kv ?? secretKv)
    if (liveNotice) warnings.push(liveNotice)
  } else if (tier === 'private') {
    await unpublishIfNeeded()
    if (recipe.visibility === 'friends-only' && idn) {
      // Narrowing to private recalls friends' copies by tombstone (H6)
      // — same best-effort limit as the delete path, same notice.
      const sharedWith = await unshareRecipeEverywhere(id, idn)
      if (sharedWith.length > 0) warnings.push(TOMBSTONE_NOTICE)
    }
    leaveP2PIfNeeded()
    await updateRecipe(repo, index, id, { visibility: 'private' })
  } else {
    await unpublishIfNeeded()
    leaveP2PIfNeeded()
    await updateRecipe(repo, index, id, { visibility: 'friends-only' })
  }
  return warnings
}
