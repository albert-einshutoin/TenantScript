# ADR-005: Secret Envelope Encryption

Date: 2026-07-20
Deciders: TenantScript maintainers
Status: Accepted

## Context

The Control Plane exchanges OAuth codes for external provider tokens and keeps public connection
records token-free, but the original Durable Object secret store wrote the token itself as its storage
value. A storage snapshot, accidental record read, or copied development database could therefore
expose provider authority even when API and log redaction worked correctly.

TenantScript needs an accountless implementation that runs in Cloudflare Workers and Node-based tests,
does not assume a paid KMS product, and leaves a stable boundary for deployment-specific key custody.
It must also support encryption-key rotation without making stored records ambiguous. Authentication
and tenant resolution remain the caller's responsibility; encryption is a defense after those checks,
not an alternative source of authority.

## Decision

`createDurableObjectSecretStore` requires a deployment-owned `SecretEncryptionKeyring`. The keyring
returns one current encryption key and resolves retained decryption keys by public key ID. Key material
is never written to `SecretStoreStorage`, a Control Plane record, a log, or an error. Production
deployments must provision these `CryptoKey` values from a secret or KMS boundary outside this store.

Each write generates a random per-record AES-256-GCM data-encryption key (DEK). The DEK encrypts the
secret and is then encrypted by the current deployment key-encryption key (KEK). Both operations use
independent random 96-bit IVs and 128-bit authentication tags. The temporary raw DEK copy needed for
wrapping is erased after use; the KEK must be non-extractable.

The provider, tenant ID, and secret ID are encoded with the envelope version and a key/data purpose as
length-delimited JSON additional authenticated data. The wrapped DEK also binds the public KEK ID.
This binds both ciphertext layers to one complete secret ref: copying a valid record to another
provider, tenant, or secret key fails authentication.

Storage contains a closed JSON envelope with exactly these fields:

- `version`: `1`;
- `algorithm`: `A256GCM`;
- `keyId`: the non-secret identifier of the KEK;
- `keyIv`: unpadded base64url IV used to wrap the DEK;
- `wrappedKey`: unpadded base64url encrypted DEK and authentication tag;
- `iv`: unpadded base64url IV used to encrypt the secret;
- `ciphertext`: unpadded base64url encrypted secret and authentication tag.

Readers validate the complete envelope before selecting a key. Malformed JSON, additional fields,
unknown versions or algorithms, invalid encodings, unavailable keys, ref mismatch, authentication
failure, and legacy plaintext all fail closed. Public errors use stable, secret-free messages and do
not expose a cryptographic cause. An absent storage record still returns `null`.

The in-memory store generates one non-extractable ephemeral AES-256-GCM key per store instance. It is
suitable for tests and demos only; its records intentionally become unreadable when that instance is
discarded.

Encryption-key rotation writes new records with the current KEK ID while retaining old KEKs for reads.
`createAesGcmSecretEncryptionKeyring` accepts strict unpadded base64url 32-byte key material at the
deployment boundary, rejects ambiguous or incomplete configuration, and imports non-extractable
AES-256-GCM keys. Callers must source the immutable input strings directly from a secret binding and
must not log, persist, or serialize them.

Because the secret has its own DEK, `rewrapSecret` can authenticate and rewrap that DEK without
decrypting or changing the provider-token ciphertext. The storage adapter must implement
`replaceIfUnchanged` as a transactional compare-and-swap: a rotation may never overwrite an OAuth
reconnect or token refresh that changed the same record concurrently. Removing an old KEK before every
associated envelope is rewrapped and read-verified makes those records unrecoverable. The normative
operator sequence and rollback boundary are documented in
[Secret KEK rotation](../operations/secret-key-rotation.md).

Trusted internal state machines can use `compareAndSwapSecret` to create, replace, or delete an
encrypted value only when its expected plaintext corresponds to the authenticated ciphertext revision.
The storage adapter compares that exact ciphertext and applies the new ciphertext (or deletion) in one
transaction. Provider-token rotation uses this primitive to keep active, candidate, and retiring tokens
inside one envelope while promotion and rollback remain atomic. Callers must never expose the expected
or next plaintext through an API, log, audit record, or conflict error.

## Consequences

- Storage no longer contains plaintext provider tokens or plaintext DEKs, and authenticated
  encryption detects record modification or movement across secret refs.
- The implementation uses the Web Crypto surface shared by Workers and the accountless test runtime;
  no Node-only crypto dependency or custom cipher construction is introduced.
- Deployments must provide an AES-256-GCM keyring. There is deliberately no plaintext or default-key
  fallback when configuration is missing.
- The repository provides strict key provisioning and a ref-level conflict-safe rewrap primitive.
  Production adapters still need a transactional compare-and-swap implementation, and production
  inventory/orchestration, rotation drills, vendor KMS integration, and legacy-data migration remain
  operational work under Issue #31.
- Provider-token sets have an encrypted CAS state machine for staging, promotion, rollback, abort, and
  finalization. Production OAuth/admin endpoints and live Durable Object transaction evidence remain
  deployment work rather than guarantees of this ADR.
- Provider-token rotation remains separate from encryption-key rotation. The accountless encrypted
  state machine and capability fallback are implemented, while production OAuth/admin orchestration,
  live provider validation, and provider-side revocation remain deployment responsibilities.
