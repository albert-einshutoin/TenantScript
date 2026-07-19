import { describe, expect, it } from "vitest";
import { createAdminCursorCodec } from "../src/admin-dashboard.js";

const secret = "cursor-secret-must-be-at-least-32-bytes-long";

describe("Admin dashboard cursor", () => {
  it("round-trips an opaque tenant-scoped section position", async () => {
    const codec = createAdminCursorCodec(secret);
    const cursor = await codec.encode({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "executions",
      position: "2026-07-19T00:00:00.000Z\texec_1"
    });

    expect(cursor).not.toContain("tenant_1");
    await expect(codec.decode(cursor)).resolves.toEqual({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "executions",
      position: "2026-07-19T00:00:00.000Z\texec_1"
    });
  });

  it("rejects tampering and weak signing secrets", async () => {
    const codec = createAdminCursorCodec(secret);
    const cursor = await codec.encode({
      appId: "app_1",
      tenantId: "tenant_1",
      section: "installations",
      position: "inst_1"
    });
    const replacement = cursor.endsWith("a") ? "b" : "a";

    await expect(codec.decode(`${cursor.slice(0, -1)}${replacement}`)).rejects.toThrow(
      "invalid Admin dashboard cursor"
    );
    expect(() => createAdminCursorCodec("too-short")).toThrow(
      "Admin cursor secret must contain at least 32 bytes"
    );
  });
});
