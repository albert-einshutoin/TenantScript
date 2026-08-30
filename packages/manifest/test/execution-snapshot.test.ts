import { describe, expect, it } from "vitest";
import {
  compileExecutionSnapshotV1,
  ExecutionSnapshotError,
  parseExecutionSnapshotV1,
  type CompileExecutionSnapshotInputV1
} from "../src/index.js";

const encoder = new TextEncoder();
const secret = "snapshot-secret-must-not-be-serialized";

function validInput(): CompileExecutionSnapshotInputV1 {
  return {
    appId: "app_1",
    tenantId: "tenant_1",
    installationId: "installation_1",
    hook: {
      name: "webhook.outbound",
      type: "transform",
      failurePolicy: "fail-closed"
    },
    pluginRelease: {
      id: "invoice-transformer",
      version: "1.2.3",
      artifactSha256: "a".repeat(64),
      runtimeClass: "inline"
    },
    grants: ["slack.send", "invoice.read"],
    configCanonicalBytes: encoder.encode('{"channel":"C123","dryRun":false}'),
    limits: {
      timeoutMs: 500,
      memoryMb: 128,
      maxSubrequests: 2,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576
    },
    destinationReferenceId: "destination_1",
    sourceRevision: 7,
    publishedAt: new Date("2026-08-29T12:34:56.789Z")
  };
}

async function expectAsyncSnapshotError(
  operation: () => Promise<unknown>,
  code: string
): Promise<void> {
  try {
    await operation();
    throw new Error("expected snapshot operation to fail");
  } catch (error) {
    expect(error).toBeInstanceOf(ExecutionSnapshotError);
    expect((error as ExecutionSnapshotError).code).toBe(code);
    expect(JSON.stringify(error)).not.toContain(secret);
  }
}

describe("Execution Snapshot V1", () => {
  it("compiles canonical immutable snapshot bytes and round-trips them", async () => {
    const compiled = await compileExecutionSnapshotV1(validInput());

    expect(compiled.digest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    expect(compiled.snapshot.snapshotId).toBe(compiled.digest);
    expect(compiled.snapshot).toMatchObject({
      schemaVersion: "1",
      appId: "app_1",
      tenantId: "tenant_1",
      installationId: "installation_1",
      hook: { name: "webhook.outbound", type: "transform", failurePolicy: "fail-closed" },
      plugin: {
        pluginId: "invoice-transformer",
        version: "1.2.3",
        artifactSha256: "a".repeat(64),
        runtimeClass: "inline"
      },
      grants: ["invoice.read", "slack.send"],
      limits: {
        timeoutMs: 500,
        memoryMb: 128,
        maxSubrequests: 2,
        maxInputBytes: 1_048_576,
        maxOutputBytes: 1_048_576
      },
      destination: { kind: "installation-webhook", referenceId: "destination_1" },
      publishedAt: "2026-08-29T12:34:56.789Z",
      sourceRevision: 7
    });
    expect(compiled.snapshot.configSha256).toMatch(/^[0-9a-f]{64}$/u);
    expect(compiled.snapshot).not.toHaveProperty("configCanonicalBytes");
    expect(JSON.stringify(compiled.snapshot)).not.toContain(secret);
    expect(Object.isFrozen(compiled.snapshot)).toBe(true);
    expect(Object.isFrozen(compiled.snapshot.hook)).toBe(true);
    expect(Object.isFrozen(compiled.snapshot.plugin)).toBe(true);
    expect(Object.isFrozen(compiled.snapshot.grants)).toBe(true);
    expect(Object.isFrozen(compiled.snapshot.limits)).toBe(true);
    expect(Object.isFrozen(compiled.snapshot.destination)).toBe(true);

    const parsed = await parseExecutionSnapshotV1(compiled.bytes);
    expect(parsed).toEqual(compiled.snapshot);
    expect(new TextDecoder().decode(compiled.bytes)).toBe(JSON.stringify(compiled.snapshot));
  });

  it("sorts grants while keeping semantic bytes and digest independent of input order", async () => {
    const first = await compileExecutionSnapshotV1(validInput());
    const secondInput = validInput();
    secondInput.grants = [...secondInput.grants].reverse();
    const second = await compileExecutionSnapshotV1(secondInput);

    expect(second.snapshot.grants).toEqual(["invoice.read", "slack.send"]);
    expect(second.digest).toBe(first.digest);
    expect(second.bytes).toEqual(first.bytes);
  });

  it("changes the digest when any authority-relevant field changes", async () => {
    const base = await compileExecutionSnapshotV1(validInput());
    const variants: CompileExecutionSnapshotInputV1[] = [];

    variants.push({ ...validInput(), appId: "app_2" });
    variants.push({ ...validInput(), tenantId: "tenant_2" });
    variants.push({ ...validInput(), installationId: "installation_2" });
    variants.push({
      ...validInput(),
      hook: { name: "invoice.created", type: "event", failurePolicy: "record-only" }
    });
    variants.push({
      ...validInput(),
      pluginRelease: { ...validInput().pluginRelease, id: "other-plugin" }
    });
    variants.push({
      ...validInput(),
      pluginRelease: { ...validInput().pluginRelease, version: "1.2.4" }
    });
    variants.push({
      ...validInput(),
      pluginRelease: { ...validInput().pluginRelease, artifactSha256: "b".repeat(64) }
    });
    variants.push({ ...validInput(), grants: ["invoice.read", "slack.send", "kv.state"] });
    variants.push({
      ...validInput(),
      configCanonicalBytes: encoder.encode('{"channel":"C124","dryRun":false}')
    });
    variants.push({
      ...validInput(),
      limits: {
        timeoutMs: 501,
        memoryMb: 128,
        maxSubrequests: 2,
        maxInputBytes: 1_048_576,
        maxOutputBytes: 1_048_576
      }
    });
    variants.push({
      ...validInput(),
      destinationReferenceId: "destination_2"
    });
    variants.push({ ...validInput(), sourceRevision: 8 });
    variants.push({ ...validInput(), publishedAt: new Date("2026-08-29T12:34:56.790Z") });

    const digests = await Promise.all(
      variants.map(async (input) => (await compileExecutionSnapshotV1(input)).digest)
    );
    expect(new Set(digests).size).toBe(variants.length);
    expect(digests).not.toContain(base.digest);
  });

  it("rejects duplicate grants and URL-shaped destination references", async () => {
    const duplicate = validInput();
    duplicate.grants = ["slack.send", "slack.send"];
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(duplicate),
      "snapshot_grant_invalid"
    );

    const urlDestination = validInput();
    urlDestination.destinationReferenceId = "https://example.com";
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(urlDestination),
      "snapshot_destination_invalid"
    );

    const schemeDestination = validInput();
    schemeDestination.destinationReferenceId = "https:example.com";
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(schemeDestination),
      "snapshot_destination_invalid"
    );
  });

  it("rejects non-canonical config bytes without storing their contents", async () => {
    const nonCanonical = validInput();
    nonCanonical.configCanonicalBytes = encoder.encode('{"dryRun":false,"channel":"C123"}');
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(nonCanonical),
      "snapshot_serialization_failed"
    );

    const unsafeInteger = validInput();
    unsafeInteger.configCanonicalBytes = encoder.encode('{"count":9007199254740992}');
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(unsafeInteger),
      "snapshot_serialization_failed"
    );

    const bomConfig = validInput();
    bomConfig.configCanonicalBytes = new Uint8Array([0xef, 0xbb, 0xbf, ...encoder.encode("{}")]);
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(bomConfig),
      "snapshot_serialization_failed"
    );

    const configWithSecret = validInput();
    configWithSecret.configCanonicalBytes = encoder.encode(`{"secret":"${secret}"}`);
    const compiled = await compileExecutionSnapshotV1(configWithSecret);
    expect(JSON.stringify(compiled.snapshot)).not.toContain(secret);
  });

  it("rejects accessors, custom prototypes, sparse arrays, and unsafe numbers without invoking accessors", async () => {
    let reads = 0;
    const accessorInput = validInput() as unknown as Record<string, unknown>;
    Object.defineProperty(accessorInput, "appId", {
      configurable: true,
      enumerable: true,
      get: () => {
        reads += 1;
        return "app_1";
      }
    });
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(accessorInput as unknown as CompileExecutionSnapshotInputV1),
      "snapshot_input_invalid"
    );
    expect(reads).toBe(0);

    const customPrototype = validInput() as unknown as Record<string, unknown>;
    Object.setPrototypeOf(customPrototype, { inherited: true });
    await expectAsyncSnapshotError(
      () =>
        compileExecutionSnapshotV1(customPrototype as unknown as CompileExecutionSnapshotInputV1),
      "snapshot_input_invalid"
    );

    const sparseGrants = validInput();
    const grants = new Array<string>(2);
    grants[1] = "slack.send";
    sparseGrants.grants = grants;
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(sparseGrants),
      "snapshot_grant_invalid"
    );

    const oversizedGrants = validInput();
    oversizedGrants.grants = new Array<string>(257).fill("grant");
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(oversizedGrants),
      "snapshot_grant_invalid"
    );

    const nonFinite = validInput();
    nonFinite.limits = {
      timeoutMs: Number.NaN,
      memoryMb: 128,
      maxSubrequests: 2,
      maxInputBytes: 1_048_576,
      maxOutputBytes: 1_048_576
    };
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(nonFinite),
      "snapshot_limit_invalid"
    );

    const negativeZero = validInput();
    negativeZero.sourceRevision = -0;
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(negativeZero),
      "snapshot_input_invalid"
    );
  });

  it("rejects tampered, reordered, and unknown snapshot bytes", async () => {
    const compiled = await compileExecutionSnapshotV1(validInput());
    const text = new TextDecoder().decode(compiled.bytes);

    const tampered = encoder.encode(text.replace('"timeoutMs":500', '"timeoutMs":501'));
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(tampered),
      "snapshot_integrity_failed"
    );

    const { publishedAt, ...snapshotWithoutPublishedAt } = compiled.snapshot;
    const reordered = encoder.encode(
      JSON.stringify({ publishedAt, ...snapshotWithoutPublishedAt })
    );
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(reordered),
      "snapshot_serialization_failed"
    );

    const unknown = encoder.encode(
      text.replace('"schemaVersion":"1"', '"unknown":true,"schemaVersion":"1"')
    );
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(unknown),
      "snapshot_serialization_failed"
    );
  });

  it("rejects invalid publication dates and exposes only stable error codes", async () => {
    const invalidDate = validInput();
    invalidDate.publishedAt = new Date(Number.NaN);
    await expectAsyncSnapshotError(
      () => compileExecutionSnapshotV1(invalidDate),
      "snapshot_serialization_failed"
    );

    const compiled = await compileExecutionSnapshotV1(validInput());
    const text = new TextDecoder().decode(compiled.bytes);
    const malformedTimestamp = encoder.encode(
      text.replace("2026-08-29T12:34:56.789Z", "2026-08-29T12:34:56Z")
    );
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(malformedTimestamp),
      "snapshot_serialization_failed"
    );

    const impossibleTimestamp = encoder.encode(
      text.replace("2026-08-29T12:34:56.789Z", "2026-02-30T12:34:56.789Z")
    );
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(impossibleTimestamp),
      "snapshot_serialization_failed"
    );

    const bomSnapshot = new Uint8Array([0xef, 0xbb, 0xbf, ...compiled.bytes]);
    await expectAsyncSnapshotError(
      () => parseExecutionSnapshotV1(bomSnapshot),
      "snapshot_serialization_failed"
    );

    const error = new ExecutionSnapshotError("snapshot_input_invalid");
    expect(error.message).toBe("snapshot_input_invalid");
    expect(error.toJSON()).toEqual({ code: "snapshot_input_invalid" });
  });
});
