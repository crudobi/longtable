# Localhost API — scripting your own cookbook

Longtable has a small HTTP API that runs **on your device**, so scripts
and other local tools can work with your cookbook: list, search, add,
edit, and delete recipes without anyone's cloud being involved.

- It is **off by default**. Nothing listens until you turn it on.
- It answers **only on the device itself** (`127.0.0.1`, "loopback").
  It is never reachable from your network or the internet.
- It runs **only while the Longtable app is open** (see
  [Lifecycle](#lifecycle)).
- It exists **only in the Android app**. In a web browser there is no
  API; the Developer panel says so instead of failing quietly.
- Every request except the health check needs a **token** (see
  [Turning it on](#turning-it-on) and
  [Security notes](#security-notes--read-these)).

The audience for this page is a developer or a power user with a
script. Everything here works with `curl` or any HTTP client.

## Turning it on

1. Open Longtable and tap **Developer** in the header.
2. Under **Localhost API**, switch on **Turn on the localhost API**.
3. The panel shows the address — by default
   `http://127.0.0.1:17337` — and your **API token**.

The token is created the first time you switch the API on. From the
same panel you can:

- **Make a new token** — the old one stops working immediately.
- **Change the port** (1024–65535) if the default clashes with
  something else on your device.
- **Switch the API off** — the socket closes at once.

Reaching it from a computer: with the Android emulator, or a phone
connected by USB with USB debugging on, forward the port once per
session:

```sh
adb forward tcp:17337 tcp:17337
# now http://127.0.0.1:17337 on the computer reaches the app
```

On the device itself, any local app or terminal can just connect to
`127.0.0.1:17337` directly.

## Lifecycle

The API is served by the Longtable app process. That means:

- Longtable must be **running** — if you force-stop it or the system
  kills it, the API is gone until you next open the app. If you left
  the API enabled, it comes back on its own when the app next starts.
- Answers are computed by the app, so a fully suspended app (screen
  off, app deep in the background) can answer slowly or time out.
  Foreground or recently used is the reliable case.
- There is deliberately **no background service**: the API never runs
  when you're not using Longtable.

## Security notes — read these

Loopback is **not** the same as private. On Android, *any* app
installed on the device can open a connection to `127.0.0.1`. The
token is the only thing standing between such an app and your
cookbook — which is why the API is off by default and why turning it
on is a deliberate act.

- The token grants **full read/write access to your local cookbook**:
  list, read, create, edit, delete, and import recipes, plus your
  device identity (DID) and your friends' names + DIDs.
- Treat the token like a password for the cookbook. Don't paste it
  into shared scripts or screenshots. If it leaks, tap **Make a new
  token** or switch the API off — both take effect immediately.
- The API can **never** hand out key material: no identity secret key,
  no friend pair secrets, no encryption keys are served by any
  endpoint.
- The API is not a back door around sharing rules. It operates on
  *your own device's* data, as you. Friends-only recipes you own are
  served as your own plaintext (they are yours); setting a recipe
  *public* through the API runs the same signed publishing flow as the
  app, and choosing *friends-only* through the API is refused — picking
  friends is something you do in the app (see
  [Visibility](#visibility-rules)).
- Anyone with your unlocked device — or USB debugging access to it —
  and the token can use the API. That's the same trust you place in
  the device itself.

## Requests and responses

All bodies are JSON. Send request bodies as `application/json`.
Responses are JSON; errors always look like:

```json
{ "error": "A plain-language sentence about what went wrong." }
```

### Authentication

Every endpoint except `GET /v1/health` requires:

```
Authorization: Bearer <your token>
```

A missing or wrong token gets **401** with an explanatory error.

### Endpoints

| Method | Path | What it does |
| --- | --- | --- |
| GET | `/v1/health` | Is the API up? (No token needed.) |
| GET | `/v1/identity` | This device's DID. |
| GET | `/v1/recipes` | List recipes; `?q=` searches title + ingredients. |
| GET | `/v1/recipes/<id>` | One full recipe. |
| POST | `/v1/recipes` | Create a recipe. |
| PUT | `/v1/recipes/<id>` | Replace a recipe's content (full update). |
| DELETE | `/v1/recipes/<id>` | Delete a recipe (and unpublish/unshare it first). |
| POST | `/v1/import` | Run an importer over text; creates what it finds. |
| GET | `/v1/friends` | Your friends' names + DIDs (read-only). |

#### `GET /v1/health`

```json
{ "ok": true, "version": "1", "app": "longtable" }
```

#### `GET /v1/identity`

```json
{ "did": "did:key:z6Mk…" }
```

Read-only. This is your public device identity — the same DID friends
pair with. The secret key behind it is never exposed.

#### `GET /v1/recipes`

```json
{
  "recipes": [
    { "id": "…", "title": "Tomato Soup", "visibility": "private",
      "updatedAt": "2026-10-13T15:04:05.000Z" }
  ]
}
```

Recipes are newest-first. `visibility` is `private`, `friends-only`,
or `public`.

With `?q=<text>`, only recipes whose title or ingredient list
contains the text (case-insensitive) are returned — handy for "what
can I cook with chickpeas": `GET /v1/recipes?q=chickpeas`.

#### `GET /v1/recipes/<id>`

The full recipe:

```json
{
  "id": "…",
  "title": "Tomato Soup",
  "ingredients": ["4 tomatoes", "1 onion"],
  "steps": ["Chop.", "Simmer 20 minutes."],
  "prepMinutes": 10,
  "cookMinutes": 20,
  "photos": [],
  "visibility": "private",
  "createdAt": "2026-10-13T15:04:05.000Z",
  "updatedAt": "2026-10-13T15:04:05.000Z"
}
```

`prepMinutes`/`cookMinutes` are absent when unset. `photos` holds
image data URLs. Unknown id → **404**.

#### `POST /v1/recipes`

Body: a recipe in the [recipe shape](#the-recipe-shape), optionally
with a `visibility` field. Creates it and answers **201**:

```json
{ "id": "…", "title": "Tomato Soup", "visibility": "private" }
```

#### `PUT /v1/recipes/<id>`

Body: the full recipe shape (this is a full update, not a patch —
fields you omit are cleared). If the body carries a `visibility`
different from the current tier, the tier change runs through the
app's real visibility flow (publishing/unpublishing included).
Answers **200** `{ "id": "…", "visibility": "…" }`. Unknown id → 404.

Editing a recipe that is already public or shared republishes the new
version exactly as an in-app edit would.

#### `DELETE /v1/recipes/<id>`

Deletes the recipe. If it was public, the public record is removed
first; if it was shared with friends, the shares are withdrawn first —
the same flow as deleting in the app. Answers **200**
`{ "id": "…", "deleted": true }`. Unknown id → 404.

#### `POST /v1/import`

Runs one of the app's registered importers (the same Importer API v1
importers the Import panel uses) over source text:

```json
{ "importerId": "longtable-json", "text": "{ \"title\": \"…\", … }" }
```

Registered importers that accept text input include `longtable-json`
(Longtable/JSON recipes), `mealie-json` (a Mealie `recipe.json`
export), and `markdown-recipe` (a Markdown recipe). The import is
**atomic**: every recipe the importer returns is validated first; if
anything is wrong, nothing is imported and you get **422** with the
reason. On success, **201**:

```json
{ "importer": "longtable-json", "imported": ["<id>", …], "count": 1 }
```

#### `GET /v1/friends`

```json
{ "friends": [ { "name": "Fay", "did": "did:key:z6Mk…" } ] }
```

Read-only, and deliberately shallow: names and DIDs only. Pair
secrets, channels, and shelf contents are not part of this API.

### The recipe shape

Creates and updates use exactly the shape an
[Importer API v1](importers.md) importer may return:

| Field | Type | Notes |
| --- | --- | --- |
| `title` | string | Required, non-empty, ≤ 500 chars. |
| `ingredients` | string[] | Required (may be empty). Each ≤ 2000 chars, ≤ 500 entries. |
| `steps` | string[] | Required (may be empty). Same limits. |
| `prepMinutes` | number | Optional, ≥ 0. |
| `cookMinutes` | number | Optional, ≥ 0. |
| `photos` | string[] | Optional. Only `data:image/…` and `http(s)://` entries are kept. |
| `visibility` | string | Optional on writes; see below. |

Validation failures are **422** with a message naming the field.

### Visibility rules

- Default is **`private`**: the recipe stays on this device.
- **`public`** is honored only when a publishing account is signed in
  on the device (in the app, under Publishing). Otherwise the request
  is refused with **422** *before anything is written* — you never get
  a surprise private copy of a failed publish. When honored, the
  recipe is published through the same signed flow the app uses
  (pubkey binding + device signature; see
  [public-protocol.md](public-protocol.md)).
- **`friends-only`** is refused with **422**. Friends-only means
  "encrypted for specific friends", and choosing those friends is an
  in-app act (the encrypted shares are created there). Save the recipe
  as private here, then share it from the app. Refusing beats faking a
  tier whose shares don't exist.

### Status codes

| Code | Means |
| --- | --- |
| 200 / 201 | Done / created. |
| 400 | The request itself is malformed (bad JSON, bad field type, nonsense tier). |
| 401 | Missing or wrong token. |
| 404 | No such recipe id, or no such endpoint. |
| 405 | That method isn't supported for that path. |
| 413 | Request body over 16 MB. |
| 422 | Well-formed but not allowed: recipe validation failed, a tier can't be honored (friends-only; public without sign-in), or an import found nothing valid. |
| 500 | Something went wrong on the device. Nothing was changed; try again. |
| 502 | A visibility change failed at the publishing server. The message says what the server said, in plain language. |
| 503 | The app is still starting up, or has no device identity yet. Try again in a moment. |
| 504 | The app didn't answer in time — it may be suspended in the background. Bring Longtable to the front and retry. |

### Versioning

The API is versioned in the path (`/v1/…`) and `GET /v1/health`
reports the version. Breaking changes will ship as `/v2/` alongside
`/v1/`, never by silently changing v1 behavior.

## Examples

### curl

```sh
export LT=http://127.0.0.1:17337
export TOKEN=<the token from Developer → Localhost API>

curl $LT/v1/health
curl -H "Authorization: Bearer $TOKEN" $LT/v1/recipes
curl -H "Authorization: Bearer $TOKEN" "$LT/v1/recipes?q=chickpeas"

curl -X POST -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"title":"Tomato Soup","ingredients":["4 tomatoes"],"steps":["Simmer."]}' \
  $LT/v1/recipes
```

### Node

[`examples/localhost-api/client.mjs`](../examples/localhost-api/) is a
dependency-free command-line client written from this page alone:

```sh
export LT_API_TOKEN=<the token>
node examples/localhost-api/client.mjs health
node examples/localhost-api/client.mjs list
node examples/localhost-api/client.mjs search miso
node examples/localhost-api/client.mjs create recipe.json
node examples/localhost-api/client.mjs import markdown-recipe recipe.md
```

## How it is built (for the curious)

A tiny native (Kotlin) plugin in the Android app owns a `ServerSocket`
bound to `127.0.0.1` and nothing else — it parses HTTP, forwards each
request to the app's JS layer, and writes the answer back. (In the
kernel's socket tables Android shows this as an IPv4-mapped IPv6
listener, `::ffff:127.0.0.1` — the same loopback-only binding; the E9
proof verifies connections via the device's real network interfaces
are refused.) All
routing, auth, validation, and storage live in `src/localapi/` in the
app, executing against the same store and the same update / delete /
visibility flows the UI uses. See
[architecture.md](architecture.md#localapi--srclocalapi).
