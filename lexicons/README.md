# Longtable lexicons

The public protocol contract for Longtable's ATProto records. These schemas
are what third-party clients and verifiers validate against.

- `kitchen.longtable.recipe` — a public recipe (schema.org-Recipe-shaped).
  Authorship is proven by the ATProto repo commit signature; the optional
  `deviceSignature` additionally binds the record to the author's Longtable
  device key (see the pubkey record).
- `kitchen.longtable.pubkey` — binds a device identity (`did:key`, Ed25519)
  to the account DID. The signature is produced by the device key over
  `longtable-pubkey:v1\n<accountDid>\n<deviceDid>\n<devicePublicKeyBase64>`.

Friends-only and private recipes never appear here — by design there is no
lexicon for them; they never touch ATProto.
