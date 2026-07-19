# Compliance audit export

`createAuditExportService()` produces a deterministic NDJSON file for one tenant/app and an
inclusive time range. Its search dependency should be `createD1R2ExecutionArchiveStore().search`,
so the export covers verified hot D1 and archived R2 evidence without exposing storage details.

## Output contract

Each NDJSON record contains only operational evidence:

- execution, tenant, plugin, hook, and version identifiers;
- status, duration, capability name/result pairs, and creation timestamp;
- `errorPresent`, which records that an error existed without exporting raw error text.

Raw error messages, hook payloads, configuration, grants, approval subjects, credentials, and
secret references are not exported. The exporter rejects any record outside the requested tenant
or inclusive time range even if a custom search implementation returns it.

The companion manifest contains schema version, tenant/app scope, requested range, generation
time, event count, SHA-256 content hash, `HMAC-SHA-256`, a public signing key ID, and the signature.
The signature commits to every manifest field except the signature itself. `verifyAuditExport()`
checks manifest shape, content hash, record count, and signature before a bundle is accepted.

## Self-host example

Provide the HMAC secret through the deployment secret manager. Never commit it to Wrangler config,
source, logs, or the export bundle. Use a random value of at least 32 bytes.

```ts
const exporter = createAuditExportService({
  search: archives.search,
  signingKey: env.AUDIT_EXPORT_SIGNING_KEY,
  signingKeyId: "audit-export-2026-07"
});

const bundle = await exporter.exportPeriod({
  appId: tenant.appId,
  tenantId: tenant.id,
  from: new Date("2026-07-01T00:00:00.000Z"),
  to: new Date("2026-07-31T23:59:59.999Z")
});
```

Store the `.ndjson` content and manifest together in the compliance case. Transport them over an
authenticated channel and apply the recipient's access/retention policy. The manifest is evidence
of integrity and origin under the shared HMAC key; it is not public-key non-repudiation.

## Key rotation and verification

1. Generate a new random secret and a new non-secret key ID.
2. Deploy both before using the new key ID for exports.
3. Retain old verification keys for at least as long as their exported bundles must be verified.
4. Resolve the manifest's `signingKeyId` to the expected secret, then call `verifyAuditExport()`.
5. Revoke a suspected key, preserve affected bundles, and regenerate them with a new key when the
   source evidence still passes D1/R2 integrity verification.

Never select a key from an untrusted manifest without checking the key ID against the tenant's
approved key registry. A failed hash, count, or signature is an integrity incident; do not edit the
bundle to make verification pass.
