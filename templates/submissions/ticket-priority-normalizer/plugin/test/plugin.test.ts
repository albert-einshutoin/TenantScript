import { describe, expect, it, vi } from "vitest";
import { plugin } from "../src/index.js";

describe("ticket-priority-normalizer", () => {
  it.each([
    [
      { subject: "  Database unavailable  " },
      { subject: "Database unavailable", priority: "normal" }
    ],
    [
      { subject: "Refund requested", priority: "high" },
      { subject: "Refund requested", priority: "high" }
    ]
  ])("normalizes a bounded ticket without capabilities for %#", async (payload, expected) => {
    const capability = vi.fn();

    const result = await plugin.dispatch({
      hookName: "ticket.created",
      payload,
      context: { capability }
    });

    expect(result).toEqual({ ok: true, value: expected });
    expect(capability).not.toHaveBeenCalled();
  });

  it.each([
    {},
    [],
    { subject: "   " },
    { subject: "x".repeat(201) },
    { subject: `${"x".repeat(200)}${" ".repeat(1_000)}` },
    { subject: "private subject", priority: "urgent" }
  ])("rejects malformed input with a fixed non-reflective error for %#", async (payload) => {
    const capability = vi.fn();

    const result = await plugin.dispatch({
      hookName: "ticket.created",
      payload,
      context: { capability }
    });

    expect(result).toEqual({
      ok: false,
      error: {
        name: "PluginHandlerError",
        hookName: "ticket.created",
        message: "invalid ticket payload"
      }
    });
    expect(capability).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private subject");
  });

  it("rejects an undeclared hook", async () => {
    const result = await plugin.dispatch({
      hookName: "ticket.deleted",
      payload: { subject: "ignored" },
      context: { capability: vi.fn() }
    });

    expect(result).toEqual({
      ok: false,
      error: { name: "UnknownHookError", hookName: "ticket.deleted" }
    });
  });
});
