import { describe, expect, it, vi } from "vitest";
import {
  createD1TelemetrySnapshotSource,
  createHttpTelemetrySink,
  parseTelemetryConfiguration,
  runTelemetrySchedule,
  type D1DatabaseLike,
  type D1PreparedStatementLike,
  type TelemetryAggregateSnapshot
} from "../src/index.js";

describe("opt-in telemetry configuration", () => {
  it.each([undefined, "false"])("defaults to disabled for %s", (enabled) => {
    expect(parseTelemetryConfiguration(enabled === undefined ? {} : { enabled })).toEqual({
      enabled: false
    });
  });

  it("accepts only an explicit enabled configuration with a public HTTPS endpoint", () => {
    expect(
      parseTelemetryConfiguration({
        enabled: "true",
        endpoint: "https://telemetry.example.com/v1/events",
        productVersion: "0.0.0",
        runtimePrimitive: "cloudflare-workers"
      })
    ).toEqual({
      enabled: true,
      endpoint: "https://telemetry.example.com/v1/events",
      productVersion: "0.0.0",
      runtimePrimitive: "cloudflare-workers"
    });
  });

  it.each([
    [{ enabled: "yes" }, "enabled must be true or false"],
    [{ enabled: "true" }, "endpoint is required"],
    [
      {
        enabled: "true",
        endpoint: "http://telemetry.example.com/events",
        productVersion: "0.0.0",
        runtimePrimitive: "cloudflare-workers"
      },
      "endpoint must be a public HTTPS URL"
    ],
    [
      {
        enabled: "true",
        endpoint: "https://127.0.0.1/events",
        productVersion: "0.0.0",
        runtimePrimitive: "cloudflare-workers"
      },
      "endpoint must be a public HTTPS URL"
    ],
    [
      {
        enabled: "true",
        endpoint: "https://receiver.internal/events",
        productVersion: "0.0.0",
        runtimePrimitive: "cloudflare-workers"
      },
      "endpoint must be a public HTTPS URL"
    ],
    [
      {
        enabled: "true",
        endpoint: "https://user@example.com/events?tenant=private",
        productVersion: "0.0.0",
        runtimePrimitive: "cloudflare-workers"
      },
      "endpoint must not contain credentials, query, or fragment"
    ],
    [
      {
        enabled: "true",
        endpoint: "https://telemetry.example.com/events",
        productVersion: "latest",
        runtimePrimitive: "cloudflare-workers"
      },
      "productVersion must be a semantic version"
    ],
    [
      {
        enabled: "true",
        endpoint: "https://telemetry.example.com/events",
        productVersion: "0.0.0",
        runtimePrimitive: "unknown"
      },
      "runtimePrimitive must be cloudflare-workers, dynamic-workers, or workers-for-platforms"
    ]
  ] as const)("rejects unsafe telemetry configuration %#", (input, message) => {
    expect(() => parseTelemetryConfiguration(input)).toThrow(message);
  });
});

describe("telemetry schedule privacy boundary", () => {
  it("does not read or send anything until explicitly enabled", async () => {
    const source = { readAggregateSnapshot: vi.fn() };
    const sink = { send: vi.fn() };

    await expect(
      runTelemetrySchedule({ configuration: { enabled: false }, source, sink })
    ).resolves.toEqual({ sent: false, reason: "disabled" });

    expect(source.readAggregateSnapshot).not.toHaveBeenCalled();
    expect(sink.send).not.toHaveBeenCalled();
  });

  it("sends only the fixed anonymous aggregate schema", async () => {
    const snapshot = {
      enabledInstallations: 12,
      executions: 345,
      errors: {
        runtime: 2,
        timeout: 3,
        egressDenied: 4,
        budgetExceeded: 5
      },
      tenantId: "tenant_must_not_cross_boundary",
      payload: { private: true },
      secret: "must-not-cross-boundary"
    } as TelemetryAggregateSnapshot & Record<string, unknown>;
    const source = { readAggregateSnapshot: vi.fn().mockResolvedValue(snapshot) };
    const sink = { send: vi.fn().mockResolvedValue(undefined) };

    await expect(
      runTelemetrySchedule({
        configuration: {
          enabled: true,
          endpoint: "https://telemetry.example.com/v1/events",
          productVersion: "0.0.0",
          runtimePrimitive: "cloudflare-workers"
        },
        source,
        sink,
        now: () => new Date("2026-07-20T02:00:00.000Z")
      })
    ).resolves.toEqual({ sent: true });

    expect(sink.send).toHaveBeenCalledWith({
      schemaVersion: 1,
      generatedAt: "2026-07-20T02:00:00.000Z",
      productVersion: "0.0.0",
      runtimePrimitive: "cloudflare-workers",
      counts: {
        enabledInstallations: 12,
        executions: 345,
        errors: {
          runtime: 2,
          timeout: 3,
          egressDenied: 4,
          budgetExceeded: 5
        }
      }
    });
    expect(JSON.stringify(sink.send.mock.calls)).not.toContain("tenant_must_not_cross_boundary");
    expect(JSON.stringify(sink.send.mock.calls)).not.toContain("must-not-cross-boundary");
  });
});

describe("telemetry adapters", () => {
  it("reads aggregate counts without selecting tenant, plugin, payload, or error text", async () => {
    const queries: string[] = [];
    const db: D1DatabaseLike = {
      prepare(query) {
        queries.push(query);
        const statement: D1PreparedStatementLike = {
          bind: () => statement,
          run: () => Promise.reject(new Error("unexpected run")),
          first: <T>() =>
            Promise.resolve({
              enabled_installations: 7,
              executions: 20,
              runtime_errors: 2,
              timeouts: 3,
              egress_denied: 4,
              budget_exceeded: 5
            } as T),
          all: () => Promise.reject(new Error("unexpected all"))
        };
        return statement;
      }
    };

    await expect(createD1TelemetrySnapshotSource(db).readAggregateSnapshot()).resolves.toEqual({
      enabledInstallations: 7,
      executions: 20,
      errors: { runtime: 2, timeout: 3, egressDenied: 4, budgetExceeded: 5 }
    });
    expect(queries).toHaveLength(1);
    expect(queries[0]).not.toMatch(/tenant_id|plugin_id|payload|secret|error\s*(?:,|FROM)/i);
  });

  it("posts a credential-free JSON event and redacts provider failures", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(null, { status: 202 }))
      .mockResolvedValueOnce(new Response("private provider failure", { status: 503 }));
    const sink = createHttpTelemetrySink({
      endpoint: "https://telemetry.example.com/v1/events",
      fetcher
    });
    const event = {
      schemaVersion: 1 as const,
      generatedAt: "2026-07-20T02:00:00.000Z",
      productVersion: "0.0.0",
      runtimePrimitive: "cloudflare-workers" as const,
      counts: {
        enabledInstallations: 1,
        executions: 2,
        errors: { runtime: 0, timeout: 0, egressDenied: 0, budgetExceeded: 0 }
      }
    };

    const unsafeEvent = {
      ...event,
      tenantId: "tenant_must_not_cross_sink",
      counts: { ...event.counts, payload: "must-not-cross-sink" }
    } as typeof event;

    await expect(sink.send(unsafeEvent)).resolves.toBeUndefined();
    const [url, init] = fetcher.mock.calls[0] ?? [];
    expect(url).toBe("https://telemetry.example.com/v1/events");
    expect(init).toMatchObject({ method: "POST", redirect: "error" });
    expect(new Headers(init?.headers).get("authorization")).toBeNull();
    expect(typeof init?.body).toBe("string");
    expect(JSON.parse(init?.body as string)).toEqual(event);
    expect(init?.body).not.toContain("tenant_must_not_cross_sink");
    expect(init?.body).not.toContain("must-not-cross-sink");

    await expect(sink.send(event)).rejects.toThrow("telemetry endpoint rejected the event");
  });
});
