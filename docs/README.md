# Longtable developer documentation

Longtable is a local-first, peer-to-peer recipe app: recipes live on the
user's devices, friends are the sync network, and public recipes are
DID-signed ATProto records that anyone can verify and no hub can forge.
This documentation is the contract surface for third-party developers.

| Document | What it covers |
|---|---|
| [architecture.md](architecture.md) | The module map: every subsystem, its public interface, and the boundaries an extension should build against. |
| [importers.md](importers.md) | The Importer API v1: how to write an importer module that the app loads and offers in its Import panel. |
| [public-protocol.md](public-protocol.md) | The public recipe protocol: lexicons, the device-key binding, the signature schemes, and the AppView API — enough to read, write, and verify public recipes without this app. |
| [../lexicons/](../lexicons/) | The `kitchen.longtable.*` lexicon JSON schemas (the normative record shapes). |
| [../examples/third-party-client/](../examples/third-party-client/) | A runnable third-party client that finds a public recipe through an AppView and verifies it end-to-end using only official ATProto libraries. |

Ground rules that shape every interface here:

- **No accounts for local use.** Identity exists only when a user pairs
  with friends or publishes; cooking never requires one.
- **Visibility is enforced by where bytes go**, not by flags: private
  recipes never leave the device, friends-only recipes travel as
  ciphertext over friend channels only, public recipes are signed
  records on the author's own PDS.
- **The hub is never trusted for content.** It provides availability
  (signaling, TURN, indexing) — authenticity always comes from
  signatures verified against DIDs.
