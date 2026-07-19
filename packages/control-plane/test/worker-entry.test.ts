import { describe, expect, it } from "vitest";
import worker from "../src/worker-entry.js";

const validIdentities = JSON.stringify({
  "manager-token": {
    subject: "manager",
    role: "manager",
    appId: "app_1",
    tenantId: "tenant_1"
  }
});

describe("Control Plane Worker configuration", () => {
  it("creates a reachable session route from valid bindings", async () => {
    const response = await worker.fetch(sessionRequest("manager-token", true), {
      ADMIN_ALLOWED_ORIGINS: JSON.stringify(["https://admin.example.com"]),
      ADMIN_IDENTITIES_JSON: validIdentities
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      subject: "manager",
      tenantId: "tenant_1"
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["array", "[]"],
    ["empty map", "{}"],
    ["empty token", JSON.stringify({ "": { subject: "manager" } })],
    ["non-object identity", JSON.stringify({ token: "manager" })]
  ])("fails closed for %s identity configuration", async (_label, identities) => {
    const response = await worker.fetch(sessionRequest("manager-token", false), {
      ...(identities === undefined ? {} : { ADMIN_IDENTITIES_JSON: identities })
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "identity_resolver_unavailable" }
    });
  });

  it.each([
    ["missing", undefined],
    ["malformed JSON", "{"],
    ["non-array", "{}"],
    ["non-string member", "[1]"]
  ])("fails closed to browser origins for %s origin configuration", async (_label, origins) => {
    const response = await worker.fetch(sessionRequest("manager-token", true), {
      ...(origins === undefined ? {} : { ADMIN_ALLOWED_ORIGINS: origins }),
      ADMIN_IDENTITIES_JSON: validIdentities
    });

    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      error: { code: "origin_forbidden" }
    });
  });
});

function sessionRequest(token: string, includeOrigin: boolean): Request {
  const headers = new Headers({ Authorization: `Bearer ${token}` });
  if (includeOrigin) {
    headers.set("Origin", "https://admin.example.com");
  }
  return new Request("https://control-plane.example.com/v1/session", { headers });
}
