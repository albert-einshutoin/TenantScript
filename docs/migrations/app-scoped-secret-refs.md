# App-scoped provider secret references

## Affected package

`@tenantscript/control-plane`

This release makes `SecretRef.appId` required and binds the app ID into the in-memory storage key,
both AES-GCM additional-authenticated-data layers, and the provider-secret Durable Object shard.
The change prevents two app-level D1 shards that reuse tenant and provider identifiers from reading
or overwriting each other's credentials.

## Before and after

Before:

```ts
const ref = {
  provider: "slack",
  tenantId: "prod",
  secretId: "slack:T123"
};
```

After:

```ts
const ref = {
  provider: "slack",
  appId: "app_acme",
  tenantId: "prod",
  secretId: "slack:T123"
};
```

Adding the field only to existing JSON is not a data migration. Legacy ciphertext was authenticated
without `appId`, and legacy Durable Object names were derived from only the tenant ID. The new reader
therefore rejects legacy records instead of guessing app authority.

## Migration procedure

Choose one of these paths for every existing provider connection before enabling normal writes on the
new version.

### Reconnect the provider (recommended)

1. Inventory each `slack_connections` row from its owning app database and record the authoritative
   app ID from the database routing configuration. Do not derive app authority from `tenantId`,
   workspace ID, callback input, or the legacy secret ref.
2. Disable or remove the legacy connection metadata through the deployment's reviewed administrative
   procedure without printing its token or `secret_ref_json` to public logs.
3. Deploy the new Worker and complete the Slack installation flow for that same app and tenant. The
   callback writes a new app-scoped encrypted record and matching D1 metadata atomically within the
   documented callback boundary.
4. Verify the connection metadata belongs to the expected app database and that a capability using the
   new ref succeeds. Revoke the superseded Slack credential if reconnecting issued a replacement.

### Controlled decrypt-and-reencrypt

Use this path only when reconnecting is not operationally possible. TenantScript does not ship an
accountless command that exports provider plaintext.

1. Freeze provider-connection writes and back up the relevant D1 metadata and Durable Object storage.
2. Run a reviewed, deployment-local migration using the old release and its existing keyring. Resolve
   `appId` from the owning app database or an equally authoritative routing record.
3. Decrypt each legacy record only inside the trusted Worker boundary. Do not return, log, persist to a
   temporary file, or send the plaintext token to another service.
4. With the new release, write the token under `{ provider, appId, tenantId, secretId }`, which creates
   new ciphertext and the app/tenant Durable Object shard. Update `slack_connections.secret_ref_json`
   in the same controlled maintenance window.
5. Read the new record through the production secret-store interface, perform a non-destructive
   provider validation, and confirm that another app reusing the same tenant/workspace IDs cannot read
   it.
6. Delete the legacy encrypted record only after verification and the deployment's rollback retention
   window. Zero any migration-process plaintext buffers as soon as the new write completes.

## Compatibility window

There is no dual-read or implicit compatibility mode. A deployment may continue running the previous
release while it prepares the migration, but it must not run old and new writers against the same
provider-connection inventory. Cut over each inventory during a controlled maintenance window.

## Rollback

- Before any record is rewritten, restore the previous Worker version and leave the legacy metadata
  unchanged.
- After a record is rewritten, do not point the previous Worker at the new app-scoped record. Roll back
  the D1 metadata and encrypted storage together from the pre-migration backup, or reconnect the
  provider on the previous version.
- If app authority cannot be established unambiguously, stop and reconnect the provider. Never assign
  an app ID by matching tenant or workspace identifiers across shards.
