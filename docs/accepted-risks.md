# Accepted risks and by-design decisions

Things Longtable deliberately does not do (or does, knowing the cost),
recorded here so a later reader does not "fix" them by accident — and
so a reviewer can see the decision instead of re-finding the gap. Each
entry names the review finding it answers. Nothing here is a secret:
the point of the record is that the trade-off is public.

## Sec L4 — No forward secrecy on add (accepted residual)

Friends-only recipes use one long-lived per-recipe secretbox key. When
a friend is added to a recipe, they receive a sealed-box envelope
holding that recipe's *existing* key, so they can read the shared
content as it stands — including content written before they were
added. The key is rotated only on unfriend, never on add.

That means there is no forward secrecy in the add direction: a
newly-added friend can decrypt everything the recipe key ever
encrypted. The reverse direction is forward-only by design, and the
app says so where you unfriend: delivered copies stay readable, and an
ex-friend only stops receiving *new* versions (the re-key on unfriend).

Why accepted: per-version or per-epoch keys would need a key history
and a re-encryption sweep on every share change, for a threat (a
friend you chose to share with reading the recipe you shared with
them) the design does not defend against. Adding a friend is a
deliberate act by the recipe owner; the protection is that only the
owner chooses who gets an envelope. What would change it: a per-epoch
key scheme with re-encryption on add — a design decision, not a bug
fix.

Mechanism: `src/friends/shelf.ts` (`ensureRecipeKey`,
`publishShare`); revocation: `src/friends/service.ts`
(`unfriendAndRekey`).

## Sec L10 — Frameable PWA / CSP connect-src breadth (accepted risk)

Two halves, one finding:

- **Frameable PWA.** The built app's Content-Security-Policy
  (`vite.config.ts`) has no `frame-ancestors` directive, so nothing
  stops another page from framing the PWA in an iframe. Accepted: the
  app has no ambient authority worth stealing through framing — there
  are no cookies, no ambient sessions, and every consequential action
  (delete, publish, unfriend, API writes) is a deliberate tap or a
  token-guarded call, not something a framing page can drive silently.
  The hub web host *does* send `frame-ancestors 'self'`
  (`hub/web-server.mjs`), because the hub serves pages to other
  origins. What would change it: adding `frame-ancestors 'self'` to
  the PWA CSP — a one-line change, if a framing-based attack ever
  becomes plausible.
- **connect-src breadth.** The CSP allows `connect-src 'self' https:
  wss: http://localhost:* ws://localhost:*` — any TLS origin, plus
  loopback plain HTTP/WS. That breadth is structural, not an oversight:
  hub, PDS, and AppView endpoints are user-configured arbitrary
  origins (`vite.config.ts:22-27` documents the rationale in the code),
  so the policy cannot name them. The `script-src 'self'
  'wasm-unsafe-eval'` half stays tight: no inline or third-party
  script execution. What would change it: a pinned-origin mode for
  users who configure only known hubs — a product decision, not a
  default.

## Sec L6 — Localhost API reads return full plaintext (by design)

`GET /v1/recipes` and `GET /v1/recipes/<id>` return the whole recipe —
title, ingredients, steps, photos — for every visibility tier,
including private and friends-only recipes the device owner owns. The
API token is the whole access control: there is no per-recipe or
per-tier authorization beyond it. This is deliberate, not a leak: the
API operates on the owner's own device data, as the owner, and the
token grants full read/write access to the local cookbook by design.
The full statement is in
[localhost-api.md](localhost-api.md#security-notes--read-these).
What would change it: per-tier API scopes — a product decision that
would need a scope model the API does not have today.

## Int L5 — Canonical-hash coverage (documented decision, format frozen)

The device-signature canonical hash covers the recipe content only:
`[name, description, ingredients, instructions, prepTimeMinutes,
cookTimeMinutes, recipeYield, tags, imageCids]`. `createdAt` /
`updatedAt`, image mime/size, and the record `$type` are NOT hashed,
so two records differing only in a timestamp, a photo's mime type or
byte size, or `$type` hash and verify identically. That is deliberate,
and it is frozen: adding a field would change the signed message
(`longtable-recipe:v1`) and invalidate every existing recipe
signature, so it can only happen as a versioned message-format change.
The full statement is in
[public-protocol.md](public-protocol.md#the-two-signatures) and in the
code at `appview/device-signature.mjs` (`canonicalRecipeHashHex`) and
`src/public/publish.ts` (`canonicalRecipeHash`).
