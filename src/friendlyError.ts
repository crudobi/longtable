/**
 * friendlyError — turn thrown values into plain-language UI copy.
 *
 * The domain layer mostly throws good messages already (invite parsers,
 * pairing, importer errors). The leaky spots are transport-level: fetch
 * TypeErrors ("Failed to fetch"), ATProto XRPC errors ("ExpiredToken",
 * raw server messages), and storage failures. Rules:
 *
 *  - Known transport failures get a specific, actionable sentence.
 *  - Error classes whose messages are written for users (ImporterError,
 *    UrlImportError, AtprotoError handled above, pairing/invite errors)
 *    pass through — but anything that looks like a stack trace, a JSON
 *    blob, or a raw "HTTP 500" style string is replaced with a generic
 *    plain sentence.
 *  - `what` names the thing being talked to for network failures
 *    (e.g. "the discovery service"), so the sentence stays specific.
 */
import { AtprotoError } from './public/atproto'
import { ImporterError } from './importers/contract'

const GENERIC = "Something went wrong, and that didn't finish. Nothing was changed — try again."

function looksRaw(message: string): boolean {
  return (
    message.length > 200 ||
    /^\s*[{[]/.test(message) ||
    /\n\s*at\s+\S+/.test(message) || // stack frames
    /HTTP \d{3}\b/.test(message) ||
    /^(TypeError|ReferenceError|SyntaxError|RangeError)\b/.test(message)
  )
}

export function friendlyError(e: unknown, what = 'the server'): string {
  // ATProto transport errors: map by status / XRPC error name.
  if (e instanceof AtprotoError) {
    if (
      e.error === 'InvalidIdentifierOrPassword' ||
      /identifier or password/i.test(e.message)
    ) {
      return 'That handle or app password was not accepted. Check both and try again.'
    }
    if (e.status === 401 || e.error === 'ExpiredToken' || e.error === 'InvalidToken') {
      return 'Your publishing sign-in has expired. Open Publishing settings and sign in again.'
    }
    if (e.status === 404 || e.error === 'RecordNotFound') {
      return "That couldn't be found on the server — it may already have been removed."
    }
    if (e.status === 400) {
      return "The server couldn't accept that. Check the address and details, then try again."
    }
    if (e.status >= 500) {
      return 'The server hit a problem on its side. Wait a moment and try again.'
    }
    return `Couldn't complete that with ${what}. Try again in a moment.`
  }

  // fetch() network failures surface as TypeError in browsers/WebViews.
  if (e instanceof TypeError && /fetch|network|load failed/i.test(e.message)) {
    return `Couldn't reach ${what}. Check your connection — and if it is run by a hub, that the hub is up.`
  }

  if (e instanceof ImporterError) return e.message

  if (e instanceof Error) {
    const msg = e.message.trim()
    // Storage-layer failures (IndexedDB / quota) get storage wording.
    if (/indexeddb|idb|quota|storage/i.test(msg)) {
      return "This device's storage ran into a problem. Free up some space and try again."
    }
    // Hub-registry developer strings become one plain sentence.
    if (/unknown hub|duplicate hub id|invalid hub configuration/.test(msg)) {
      return "That hub entry looks invalid — it wasn't saved."
    }
    if (msg && !looksRaw(msg)) return msg
  }
  return GENERIC
}
