import { describe, expect, it, vi } from "vitest";
import {
  createRotatingTokenCapabilityProvider,
  ProviderCredentialRejectedError,
  type ProviderTokenRotationSnapshot
} from "../src/index.js";

describe("rotating provider token capability", () => {
  it("uses the candidate without invoking the active token when it succeeds", async () => {
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => ({
        candidate: { id: "candidate-v2", value: "candidate-secret" },
        active: { id: "active-v1", value: "active-secret" }
      }),
      invoke
    });

    await expect(provider({ message: "hello" })).resolves.toEqual({ ok: true });
    expect(invoke).toHaveBeenCalledTimes(1);
    expect(invoke).toHaveBeenCalledWith({
      token: "candidate-secret",
      input: { message: "hello" }
    });
  });

  it("falls back once to the active token only after explicit credential rejection", async () => {
    const invoke = vi
      .fn()
      .mockRejectedValueOnce(new ProviderCredentialRejectedError())
      .mockResolvedValueOnce({ ok: true, token: "active" });
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => ({
        candidate: { id: "candidate-v2", value: "candidate-secret" },
        active: { id: "active-v1", value: "active-secret" }
      }),
      invoke
    });

    await expect(provider({ message: "hello" })).resolves.toEqual({ ok: true, token: "active" });
    expect(invoke).toHaveBeenNthCalledWith(1, {
      token: "candidate-secret",
      input: { message: "hello" }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      token: "active-secret",
      input: { message: "hello" }
    });
  });

  it.each([new Error("network failed"), new TypeError("timed out"), { status: 429 }])(
    "does not retry an ambiguous provider failure %#",
    async (failure) => {
      const invoke = vi.fn().mockRejectedValue(failure);
      const provider = rotatingProvider(invoke);

      await expect(provider({ message: "one-shot" })).rejects.toThrow("provider invocation failed");
      expect(invoke).toHaveBeenCalledTimes(1);
    }
  );

  it("fails closed without exposing either token when both credentials are rejected", async () => {
    const invoke = vi.fn().mockRejectedValue(new ProviderCredentialRejectedError());
    const provider = rotatingProvider(invoke);

    let caught: unknown;
    try {
      await provider({ message: "hello" });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("provider credentials were rejected");
    expect((caught as Error).message).not.toContain("candidate-secret");
    expect((caught as Error).message).not.toContain("active-secret");
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["missing active", { candidate: { id: "candidate-v2", value: "candidate-secret" } }],
    [
      "duplicate id",
      {
        candidate: { id: "token-v1", value: "candidate-secret" },
        active: { id: "token-v1", value: "active-secret" }
      }
    ],
    ["empty token", { active: { id: "active-v1", value: "" } }],
    ["invalid id", { active: { id: "bad id", value: "active-secret" } }]
  ])("rejects an invalid snapshot: %s", async (_name, snapshot) => {
    const invoke = vi.fn();
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => snapshot as ProviderTokenRotationSnapshot,
      invoke
    });

    await expect(provider({})).rejects.toThrow("provider token snapshot is invalid");
    expect(invoke).not.toHaveBeenCalled();
  });

  it("uses a fresh token snapshot for every call", async () => {
    let active = { id: "active-v1", value: "first-secret" };
    const invoke = vi.fn().mockResolvedValue({ ok: true });
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => ({ active }),
      invoke
    });

    await provider({ sequence: 1 });
    active = { id: "active-v2", value: "second-secret" };
    await provider({ sequence: 2 });

    expect(invoke).toHaveBeenNthCalledWith(1, {
      token: "first-secret",
      input: { sequence: 1 }
    });
    expect(invoke).toHaveBeenNthCalledWith(2, {
      token: "second-secret",
      input: { sequence: 2 }
    });
  });

  it("sanitizes token source failures", async () => {
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => {
        throw new Error("could not read active-secret");
      },
      invoke: vi.fn()
    });

    await expect(provider({})).rejects.toThrow("provider token source is unavailable");
  });

  it("sanitizes throwing snapshot accessors before invoking a provider", async () => {
    const invoke = vi.fn();
    const snapshot = Object.defineProperty({}, "active", {
      enumerable: true,
      get: () => {
        throw new Error("getter exposed active-secret");
      }
    });
    const provider = createRotatingTokenCapabilityProvider({
      resolveTokens: () => snapshot as ProviderTokenRotationSnapshot,
      invoke
    });

    await expect(provider({})).rejects.toThrow("provider token snapshot is invalid");
    expect(invoke).not.toHaveBeenCalled();
  });
});

function rotatingProvider(invoke: (request: { token: string; input: unknown }) => unknown) {
  return createRotatingTokenCapabilityProvider({
    resolveTokens: () => ({
      candidate: { id: "candidate-v2", value: "candidate-secret" },
      active: { id: "active-v1", value: "active-secret" }
    }),
    invoke
  });
}
