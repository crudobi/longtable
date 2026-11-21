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
import { unshareRecipeEverywhere } from './friends/service'
import {
  ensurePubkeyBinding,
  getPublication,
  publishRecipe,
  unpublishRecipe,
} from './public/publish'
import { AtprotoClient, loadSession, saveSession } from './public/atproto'
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

export interface FlowContext {
  identity: Identity | null
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

/**
 * The delete flow itself, without the confirmation prompt or UI
 * navigation: strip friends-only shares, remove the public record, leave
 * the P2P room, then delete locally. The local delete always proceeds —
 * deleting here is the user's act — but if a remote removal fails, the
 * caller is told plainly (via onRemoteProblem) that the shared/public
 * copy may still be live; it is never swallowed quietly.
 */
export async function performDeleteFlow(id: string, ctx: FlowContext): Promise<void> {
  // Strip friends-only shares of this recipe from friends' channels.
  const idn = ctx.identity
  if (idn) {
    await unshareRecipeEverywhere(id, idn).catch((e) => {
      console.warn('unshare failed', e)
      ctx.onRemoteProblem?.('the copies shared with friends')
    })
  }
  // If it was published publicly, remove the ATProto record first.
  if (getPublication(id)) {
    const session = loadSession()
    if (session) {
      await unpublishRecipe(new AtprotoClient(session.pdsUrl), session, id).catch(
        (e) => {
          console.warn('unpublish failed', e)
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
 *                  started, and the content is public anyway.
 *   → private:     unpublish the ATProto record first (if any); strip
 *                  friends-only shares everywhere (if friends-only);
 *                  leave the P2P room; then mark 'private'.
 *   → friends-only: unpublish the ATProto record first (if any); leave
 *                  the P2P room; mark 'friends-only'. (Choosing friends
 *                  and publishing the encrypted shares is the friend
 *                  picker's job — the UI wrapper opens it after this
 *                  runs.)
 */
export async function applyVisibilityFlow(
  id: string,
  recipe: Recipe,
  tier: VisibilityTier,
  ctx: FlowContext,
): Promise<void> {
  const repo = getRepo()
  const index = await getOrCreateIndex(repo)
  const idn = ctx.identity
  const publication = getPublication(id)
  const unpublishIfNeeded = async () => {
    if (!publication) return
    const session = loadSession()
    if (!session) return
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
  } else if (tier === 'private') {
    await unpublishIfNeeded()
    if (recipe.visibility === 'friends-only' && idn) {
      await unshareRecipeEverywhere(id, idn)
    }
    leaveP2PIfNeeded()
    await updateRecipe(repo, index, id, { visibility: 'private' })
  } else {
    await unpublishIfNeeded()
    leaveP2PIfNeeded()
    await updateRecipe(repo, index, id, { visibility: 'friends-only' })
  }
}
