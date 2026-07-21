import { createCapabilityBroker, createSlackSendProvider } from "@tenantscript/capabilities";
import {
  createInMemorySecretStore,
  createSlackCredentialLifecycleManager,
  type CapabilityCallRecord,
  type SecretRef
} from "@tenantscript/control-plane";
import { describe, expect, it, vi } from "vitest";

const ref: SecretRef = {
  provider: "slack",
  appId: "app_1",
  tenantId: "tenant_1",
  secretId: "slack:T123"
};

describe("production Slack capability composition", () => {
  it("rotates a due credential before one brokered send without exposing either token", async () => {
    const oldAccessToken = "xoxe.xoxb-old-access-secret";
    const oldRefreshToken = "xoxe-old-refresh-secret";
    const newAccessToken = "xoxe.xoxb-new-access-secret";
    const newRefreshToken = "xoxe-new-refresh-secret";
    const secretStore = createInMemorySecretStore();
    await secretStore.putSecret({
      ref,
      value: JSON.stringify({
        version: 1,
        status: "ready",
        generation: 1,
        tokenId: "slack_1234567890abcdef",
        accessToken: oldAccessToken,
        refreshToken: oldRefreshToken,
        expiresAt: "2026-07-21T01:00:00.000Z"
      })
    });
    const refresh = vi.fn().mockResolvedValue({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken,
      expiresIn: 43_200
    });
    const lifecycle = createSlackCredentialLifecycleManager({
      secretStore,
      ref,
      refreshClient: { refresh },
      now: () => new Date("2026-07-21T00:56:00.000Z"),
      refreshSkewMs: 5 * 60_000,
      maxJitterMs: 0
    });
    const slackFetch = vi.fn<typeof fetch>().mockImplementation((_url, init) => {
      expect(refresh).toHaveBeenCalledWith(oldRefreshToken);
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${newAccessToken}`);
      return Promise.resolve(
        Response.json({ ok: true, channel: "C12345678", ts: "1712345678.123456" })
      );
    });
    const audits: CapabilityCallRecord[] = [];
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C12345678" } },
      providers: {
        "slack.send": createSlackSendProvider({
          resolveAccessToken: lifecycle.resolveAccessToken,
          fetcher: slackFetch
        })
      },
      auditSink: {
        writeCapabilityAudit: (record) => {
          audits.push({ name: record.capability, status: record.status });
        }
      }
    });

    const result = await broker.call("slack.send", {
      channel: "C12345678",
      text: "Deployment completed"
    });

    expect(result).toEqual({ channel: "C12345678", timestamp: "1712345678.123456" });
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(slackFetch).toHaveBeenCalledTimes(1);
    expect(audits).toEqual([{ name: "slack.send", status: "success" }]);
    const observable = JSON.stringify({ result, audits });
    for (const secret of [oldAccessToken, oldRefreshToken, newAccessToken, newRefreshToken]) {
      expect(observable).not.toContain(secret);
    }
  });
});
