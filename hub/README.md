# Run a Longtable hub

A Longtable hub is one tarball and one command. A hub helps Longtable
clients find each other, relays their (encrypted) sync traffic, relays
media streams for NAT traversal, and indexes *public* recipes so people
can discover them.

**What a hub can never do:** read anything. Friend traffic is end-to-end
encrypted on the devices; the relay only sees ciphertext. Public recipes
are cryptographically signed on the author's device and the hub verifies
the signature before indexing — a hub cannot forge or alter them. All of
a user's recipes, friends, and identity live on their own devices, so
**any hub can disappear at any time and nobody loses anything** — clients
fail over to any other hub they know, or pair directly with no hub at all.

## Requirements

- Linux or macOS with **Node.js 20+** and **openssl** on `PATH`
- Optional: **coturn** (`turnserver` on `PATH`) for the TURN relay.
  Without it, devices on the same network (or with direct connectivity)
  still sync; TURN only helps across restrictive NATs.
- About 600 MB of disk for the bundle, plus your data directory.

## Install and start (5 minutes)

```sh
tar xzf longtable-hub-*.tar.gz
cd longtable-hub-*/
cp hub.conf.example.json hub.conf.json
```

Edit `hub.conf.json`. The fields that matter:

| Field | Meaning |
|---|---|
| `name` | Any label for your hub. |
| `dataDir` | The ONE directory where all hub state lives (index DB, media cache, PDS data, TLS, logs). Default `./data`. |
| `publicHost` | The hostname/IP clients use to reach this machine. Shown in the endpoint summary. |
| `web.port` | Serves the Longtable web app (default 8080). |
| `signaling.port` | y-webrtc signaling over wss (default 4444). |
| `turn.password` | Optional. If unset (or left at a placeholder), the hub **generates** a strong password on first start, prints it in the start output, and stores it in `data/turn-password.txt`. Clients need the matching username/password configured in their hub entry. |
| `turn.externalIp` | Your public IP, if the hub is behind NAT and clients connect from elsewhere. |
| `appview.port` | Public-recipe search API (default 3210). |
| `pds.enabled` | Run the bundled managed PDS (default `true`). See the honest note below. |
| `tls.san` | SubjectAltName for the auto-generated self-signed cert, e.g. `"IP:203.0.113.7,DNS:hub.example.org"`. Set this to how clients reach the hub. |
| `tls.cert` / `tls.key` / `tls.certDir` | Bring your own certificate instead of the self-signed one. `certDir` must contain `server.crt` and `server.key`. |
| `tls.proxies` | HTTPS ports that expose the AppView and PDS to devices: `{ "appviewPort": 3211, "pdsPort": 2584 }`, or `null` to disable. |

A note on the TURN relay: its credentials are shared with every client
of your hub by design, so the generated coturn config refuses to relay
toward loopback, private (RFC1918), CGNAT, link-local, or multicast
addresses — the relay can carry traffic between your hub's users, but
it cannot be used to reach your LAN or the hub host itself.

If a default port is already taken on your machine, change it here —
every component's port is configurable.

Then:

```sh
./longtable-hub start
./longtable-hub status     # prints the endpoints clients need
./longtable-hub logs       # follow along (Ctrl-C to detach)
```

## Create public-publishing accounts (optional)

Public recipes live on a PDS. With the bundled PDS running:

```sh
cd services/atproto-testnet
PDS_URL=http://localhost:2583 ACCOUNTS_FILE=../../data/accounts.json node seed.mjs
cd ../..
```

This creates the two starter accounts and writes their handles,
passwords, and DIDs to `data/accounts.json`. The password is generated
by the seed run and printed once in its output (or set
`LT_SEED_PASSWORD` to choose it) — there is deliberately no default
password, and `data/accounts.json` should be treated as a secret.
(The PDS port in `PDS_URL` must match `pds.pdsPort` in your config.)

## Point the app at your hub

In Longtable: **Hubs → Add hub**, and enter the values `./longtable-hub
status` printed (signaling wss URL, TURN URL + username/password,
AppView URL, PDS URL). Adding a hub makes it the active one; you can
switch between hubs at any time — switching never loses data, because no
user data lives on a hub.

Devices must trust the hub's TLS certificate for signaling (wss). With
the self-signed default on Android: copy `data/tls/server.crt` to the
device and install it as a CA certificate (Settings → Security →
Encryption & credentials → Install a certificate → CA certificate).
For real deployments, use a certificate from a public CA via
`tls.cert`/`tls.key` and nobody has to install anything.

## Running several hubs on one machine

Unpack the tarball again in a second directory, give it its own config
with a different `dataDir` and different ports, and start it the same
way. Hubs are fully independent — clients listed on both keep syncing if
either one dies.

```sh
LT_HUB_CONFIG=./hub-b.conf.json ./longtable-hub start
```

## Honest notes

- **The bundled PDS is a dev-grade testnet.** It is the real ATProto PDS
  software, but its PLC directory keeps registrations in memory:
  accounts and DIDs vanish when the hub restarts (PDS repo data persists
  under `dataDir/pds`). That is fine for a home hub or a community pilot.
  For production, run a real PDS (e.g. the standard `pds` deployment),
  set `pds.enabled` to `false`, set `appview.pdsUrl` / `appview.plcUrl`
  to it, and give clients its URL in their hub entry.
- **Revocation is forward-only.** Removing a friend stops future sharing;
  copies they already decrypted are theirs. This is inherent to
  offline-first sharing and the app says so.
- **No telemetry.** The hub and the app make no analytics, tracking, or
  phone-home connections of any kind. See `TELEMETRY.md` for the audited
  list of every outbound connection each component makes.

## Stop

```sh
./longtable-hub stop
```

Your data stays in `dataDir`; delete it to wipe the hub completely.
Clients are unaffected either way.
