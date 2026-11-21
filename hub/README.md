# Run a Longtable hub

A Longtable hub is one tarball and one command. A hub helps Longtable
clients find each other, relays their (encrypted) sync traffic, relays
media streams for NAT traversal, and indexes *public* recipes so people
can discover them.

**What a hub can never do:** read anything. Friend traffic is end-to-end
encrypted on the devices; the relay only sees ciphertext. Public recipes
are signed on the author's device (Ed25519 device key) and the hub's
AppView verifies each signature before indexing: at ingest it loads the
author's `kitchen.longtable.pubkey/self` binding from the same
signature-verified repo, checks the binding signature and that the bound
key matches the device DID, then recomputes each recipe's canonical hash
and verifies its device signature against the bound key — records that
fail any check are dropped and counted, never indexed. The AppView also
serves each recipe's `deviceDid`, `deviceSignature` and bound `deviceKey`
so clients can re-verify the signature themselves before displaying it.
(The repo-commit signature alone is not this guarantee — the PDS holds
the repo key and produces it.) All of a user's recipes, friends, and
identity live on their own devices, so
**any hub can disappear at any time and nobody loses anything** — clients
fail over to any other hub they know, or pair directly with no hub at all.

## Requirements

- Linux or macOS with **Node.js 22.5+** and **openssl** on `PATH`
  (the AppView uses `node:sqlite`, which Node 20 cannot load)
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
| `web.tls` | `true` serves the web app over HTTPS with the hub's own certificate (same cert as signaling); `false` (default) serves plain HTTP. The hub's cert is normally self-signed, so browsers warn on it — for a public deployment bring a CA cert via `tls.cert`/`tls.key`. Every response carries `nosniff`, `SAMEORIGIN` framing, `no-referrer`, and a `frame-ancestors 'self'` CSP, and error responses are generic (no error strings leak to clients). |
| `signaling.port` | y-webrtc signaling over wss (default 4444). |
| `turn.password` | Optional. If unset (or left at a placeholder), the hub **generates** a strong password on first start and stores it in `data/turn-password.txt` (0600). The value is never printed — the start output gives only its length and the file path, because hub stdout goes to `data/hub.log` (0600). Clients need the matching username/password configured in their hub entry; read the value from `data/turn-password.txt`. See "Rotating the TURN password" below. |
| `turn.externalIp` | Your public IP, if the hub is behind NAT and clients connect from elsewhere. |
| `appview.port` | Public-recipe search API (default 3210). |
| `pds.enabled` | Run the bundled managed PDS (default `true`). See the honest note below. |
| `tls.san` | SubjectAltName for the auto-generated self-signed cert, e.g. `"IP:203.0.113.7,DNS:hub.example.org"`. Set this to how clients reach the hub. |
| `tls.cert` / `tls.key` / `tls.certDir` | Bring your own certificate instead of the self-signed one. `certDir` must contain `server.crt` and `server.key`. |
| `tls.proxies` | HTTPS ports that expose the AppView and PDS to devices: `{ "appviewPort": 3211, "pdsPort": 2584 }`, or `null` to disable. |

A note on the TURN relay: its credentials are shared with every client
of your hub by design, so the generated coturn config refuses to relay
toward loopback, private (RFC1918), CGNAT, link-local, multicast,
benchmarking, and reserved addresses — the relay can carry traffic
between your hub's users, but it cannot be used to reach your LAN or
the hub host itself. The relay is also capped: at most 100 concurrent
allocations in total (`total-quota`/`user-quota`), 1 MiB/s per session
(`max-bps`) and 50 MiB/s of relay capacity overall (`bps-capacity`) —
so one abusive client cannot take the relay or the host's uplink
without bound. `data/turnserver.conf` (which embeds the plaintext
credential) is written 0600 via tmp+rename, and `data/hub.log` is 0600
too.

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

## Rotating the TURN password

The TURN credential is one static password shared by every client of
the hub, so rotate it whenever it may have leaked (and after any
reinstall that re-uses an old config):

```sh
./longtable-hub stop
rm data/turn-password.txt
# or: set "turn.password" in hub.conf.json to a new value
./longtable-hub start
```

On start the hub mints a fresh generated password (or uses the one in
`hub.conf.json`) and rewrites `data/turnserver.conf` (0600). Clients
must update their hub entry to the new credential — the old one stops
working at once, and there is no grace period. The generated password
is 24 random bytes; never commit a `hub.conf.json` carrying a real
`turn.password`.

## Run under systemd (supervisor restart)

`./longtable-hub start` launches the supervisor with `setsid`+`nohup`
and nothing restarts it if it dies. For an unattended hub, run it
under systemd instead — `longtable-hub.service` ships in the tarball:

```sh
# Stop the manual instance first — never run both at once.
./longtable-hub stop
# Edit WorkingDirectory and the paths in ExecStart to the directory
# you unpacked the tarball into, and User= to the hub's user.
sudo cp longtable-hub.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now longtable-hub
```

The unit restarts the supervisor on failure with backoff
(`Restart=on-failure`, 5 s), and holds the unit failed after 5
restarts in 5 minutes so a crash loop gets operator attention instead
of spinning forever. The supervisor itself already restarts its
children (web, signaling, AppView, TURN, PDS) with backoff; the unit
covers the supervisor process. `./longtable-hub status` / `logs`
still work against the same data dir.

## Health endpoint

The hub as a whole exposes one health endpoint (production blocker
#14): `GET /healthz` on the web port.

```sh
curl http://localhost:8080/healthz
# {"ok":true,"name":"longtable-hub","heartbeatAt":"...","heartbeatAgeMs":1200,
#  "children":{"web":{"pid":1234,"restarts":0}, ...}, "endpoints":{...}}
```

`ok` is true only while the supervisor itself is alive: the
supervisor rewrites `hub-status.json` every 15 s with a fresh
`heartbeatAt`, and `/healthz` answers 200 only when that heartbeat
is under 60 s old. A stale heartbeat, a missing/unparseable status
file, or a web server running without a hub all answer 503 — the
endpoint never reports "up" from a stale file while the supervisor
is dead (the web child would keep serving the app shell otherwise).
AppView, signaling and the PDS keep their own `/health` endpoints;
`/healthz` is the hub-level roll-up. At startup the supervisor also
waits for every child before reporting up — web, signaling, AppView,
PDS, plus TURN (TCP connect, only when the relay actually started)
and both TLS proxies (body-matched HTTPS GETs through the proxy, so
a proxy answering with the wrong backend does not read as ready).

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
