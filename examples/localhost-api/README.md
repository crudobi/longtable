# Localhost API example client

`client.mjs` is a dependency-free command-line client for Longtable's
**localhost API** — the on-device HTTP API documented in
[docs/localhost-api.md](../../docs/localhost-api.md). It was written
from that document alone, and it is the client the E9 proof
(`e2e/proof-localapi.mjs`) drives end to end.

## Run it

1. In the Longtable Android app: **Developer → Localhost API → turn it
   on**, and note the token it shows.
2. From a computer connected to the emulator or a USB-attached phone,
   forward the port: `adb forward tcp:17337 tcp:17337`
3. 

```sh
export LT_API_TOKEN=<the token from the app>
node client.mjs health
node client.mjs create sample-recipe.json
node client.mjs list
node client.mjs search miso
```

Commands: `health`, `identity`, `friends`, `list`, `search <words>`,
`get <id>`, `create <file.json>`, `update <id> <file.json>`,
`delete <id>`, `import <importer-id> <text-file>`. The address
defaults to `http://127.0.0.1:17337` (`LT_API_URL` overrides).
