import { describe, expect, it, vi } from "vitest";
import {
  CapabilityDeniedError,
  createCapabilityBroker,
  createMockSlackSendProvider,
  createPluginCapabilityContext
} from "../src/index.js";

describe("createCapabilityBroker", () => {
  it("allows granted capability calls", async () => {
    const provider = vi.fn().mockResolvedValue({ ok: true });
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": provider }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "hello" })).resolves.toEqual({
      ok: true
    });
    expect(provider).toHaveBeenCalledWith({ channel: "C123", text: "hello" });
  });

  it("rejects ungranted capabilities", async () => {
    const broker = createCapabilityBroker({
      grants: {},
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C123", text: "hello" })).rejects.toThrow(
      CapabilityDeniedError
    );
  });

  it("rejects calls outside the granted channel scope", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: { "slack.send": vi.fn() }
    });

    await expect(broker.call("slack.send", { channel: "C999", text: "hello" })).rejects.toThrow(
      "slack.send channel C999 is outside granted scope"
    );
  });
});

describe("createMockSlackSendProvider", () => {
  it("delivers payloads without exposing the raw token to plugin context", async () => {
    const deliver = vi.fn();
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": createMockSlackSendProvider({
          token: "xoxb-secret-token",
          deliver
        })
      }
    });
    const context = createPluginCapabilityContext(broker);

    await expect(
      context.capability("slack.send", { channel: "C123", text: "hello" })
    ).resolves.toEqual({
      ok: true,
      provider: "mock-slack"
    });

    expect(deliver).toHaveBeenCalledWith({ channel: "C123", text: "hello" });
    expect(JSON.stringify(context)).not.toContain("xoxb-secret-token");
  });

  it("rejects malformed Slack payloads", async () => {
    const broker = createCapabilityBroker({
      grants: { "slack.send": { channel: "C123" } },
      providers: {
        "slack.send": createMockSlackSendProvider({
          token: "xoxb-secret-token",
          deliver: vi.fn()
        })
      }
    });

    await expect(broker.call("slack.send", { channel: "C123" })).rejects.toThrow(
      "slack.send requires channel and text"
    );
  });
});
