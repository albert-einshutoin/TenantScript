import { describe, expect, it } from "vitest";
import {
  CloudflareApiError,
  createCloudflareApiTransport,
  type CloudflareFetch
} from "../src/index.js";

const accountId = "0123456789abcdef0123456789abcdef";
const apiToken = "cf-token-secret-sentinel";

describe("Cloudflare API transport", () => {
  it("sends credentials only in Authorization and projects a successful result", async () => {
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      fetch: (input, init) => {
        requests.push({ url: input, init });
        return Promise.resolve(
          jsonResponse({
            success: true,
            result: { uuid: "database-id", name: "tenant-db" },
            errors: [],
            messages: [],
            result_info: { page: 1 }
          })
        );
      }
    });

    await expect(
      transport.request({
        method: "POST",
        pathSegments: ["d1", "database"],
        query: { jurisdiction: "eu", page: "1" },
        body: { name: "tenant-db" }
      })
    ).resolves.toEqual({ uuid: "database-id", name: "tenant-db" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe(
      `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database?jurisdiction=eu&page=1`
    );
    expect(requests[0]?.init).toMatchObject({
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${apiToken}`,
        "Content-Type": "application/json"
      },
      body: '{"name":"tenant-db"}'
    });
    expect(requests[0]?.url).not.toContain(apiToken);
    expect(requests[0]?.init.body).not.toContain(apiToken);
  });

  it.each([
    ["absolute URL", ["https://attacker.example"]],
    ["path traversal", ["d1", "..", "database"]],
    ["encoded slash", ["d1", "database%2Fescape"]],
    ["empty segment", ["d1", ""]]
  ])("rejects %s before fetch", async (_name, pathSegments) => {
    let called = false;
    const transport = createTransport(() => {
      called = true;
      return Promise.resolve(jsonResponse({ success: true, result: null }));
    });

    await expect(transport.request({ method: "GET", pathSegments })).rejects.toMatchObject({
      code: "cloudflare_api_invalid_request"
    });
    expect(called).toBe(false);
  });

  it("rejects invalid account, token, and query configuration without reflecting values", async () => {
    expect(() =>
      createCloudflareApiTransport({
        accountId: "../../secret-sentinel",
        apiToken,
        fetch: () => Promise.resolve(jsonResponse({ success: true, result: null }))
      })
    ).toThrow("cloudflare API configuration is invalid");
    expect(() =>
      createCloudflareApiTransport({
        accountId,
        apiToken: "Bearer secret-sentinel",
        fetch: () => Promise.resolve(jsonResponse({ success: true, result: null }))
      })
    ).toThrow("cloudflare API configuration is invalid");

    const transport = createTransport(() =>
      Promise.resolve(jsonResponse({ success: true, result: null }))
    );
    const error = await captureApiError(
      transport.request({ method: "GET", pathSegments: ["d1"], query: { "bad/key": apiToken } })
    );
    expect(JSON.stringify(error)).not.toContain(apiToken);
  });

  it.each([
    [401, "cloudflare_api_unauthorized"],
    [403, "cloudflare_api_unauthorized"],
    [429, "cloudflare_api_rate_limited"],
    [500, "cloudflare_api_unavailable"],
    [400, "cloudflare_api_request_failed"]
  ] as const)("maps HTTP %i to %s without provider error text", async (status, code) => {
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      maxGetAttempts: 1,
      fetch: () =>
        Promise.resolve(
          jsonResponse(
            {
              success: false,
              result: null,
              errors: [{ code: 1000, message: `provider ${apiToken}` }]
            },
            { status, ...(status === 429 ? { headers: { "Retry-After": "2" } } : {}) }
          )
        )
    });

    const error = await captureApiError(
      transport.request({ method: "GET", pathSegments: ["d1", "database"] })
    );
    expect(error).toMatchObject({ code, status });
    expect(JSON.stringify(error)).not.toContain(apiToken);
    expect(error.message).toBe(code);
  });

  it("retries only GET with bounded Retry-After and server backoff", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        if (calls === 1) {
          return Promise.resolve(
            jsonResponse(
              { success: false, result: null },
              { status: 429, headers: { "Retry-After": "2" } }
            )
          );
        }
        if (calls === 2) {
          return Promise.resolve(jsonResponse({ success: false, result: null }, { status: 503 }));
        }
        return Promise.resolve(jsonResponse({ success: true, result: { ok: true } }));
      }
    });

    await expect(
      transport.request({ method: "GET", pathSegments: ["d1", "database"] })
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(3);
    expect(sleeps).toEqual([2_000, 500]);
  });

  it("recovers from a bounded GET network failure without exposing the cause", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      sleep: (milliseconds) => {
        sleeps.push(milliseconds);
        return Promise.resolve();
      },
      fetch: () => {
        calls += 1;
        return calls === 1
          ? Promise.reject(new Error(`network ${apiToken}`))
          : Promise.resolve(jsonResponse({ success: true, result: { ok: true } }));
      }
    });

    await expect(
      transport.request({ method: "GET", pathSegments: ["d1", "database"] })
    ).resolves.toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(sleeps).toEqual([250]);
  });

  it.each(["not-a-delay", "11"])(
    "fails closed on an invalid or excessive Retry-After value %s",
    async (retryAfter) => {
      const sleeps: number[] = [];
      let calls = 0;
      const transport = createCloudflareApiTransport({
        accountId,
        apiToken,
        sleep: (milliseconds) => {
          sleeps.push(milliseconds);
          return Promise.resolve();
        },
        fetch: () => {
          calls += 1;
          return Promise.resolve(
            jsonResponse(
              { success: false, result: null },
              { status: 429, headers: { "Retry-After": retryAfter } }
            )
          );
        }
      });

      await expect(
        transport.request({ method: "GET", pathSegments: ["d1", "database"] })
      ).rejects.toMatchObject({ code: "cloudflare_api_rate_limited", status: 429 });
      expect(calls).toBe(1);
      expect(sleeps).toEqual([]);
    }
  );

  it.each(["POST", "PUT", "PATCH", "DELETE"] as const)(
    "never automatically retries %s mutations",
    async (method) => {
      let calls = 0;
      const transport = createTransport(() => {
        calls += 1;
        return Promise.resolve(jsonResponse({ success: false, result: null }, { status: 503 }));
      });

      await expect(
        transport.request({ method, pathSegments: ["d1", "database"], body: { value: apiToken } })
      ).rejects.toMatchObject({ code: "cloudflare_api_unavailable" });
      expect(calls).toBe(1);
    }
  );

  it("does not retry a mutation after a network failure", async () => {
    let calls = 0;
    const transport = createTransport(() => {
      calls += 1;
      return Promise.reject(new Error(`network ${apiToken}`));
    });

    const error = await captureApiError(
      transport.request({ method: "POST", pathSegments: ["r2", "buckets"], body: { name: "x" } })
    );
    expect(error.code).toBe("cloudflare_api_unavailable");
    expect(calls).toBe(1);
    expect(JSON.stringify(error)).not.toContain(apiToken);
  });

  it("rejects GET bodies and oversized request bodies before fetch", async () => {
    let calls = 0;
    const fetch: CloudflareFetch = () => {
      calls += 1;
      return Promise.resolve(jsonResponse({ success: true, result: null }));
    };
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      fetch,
      maxRequestBytes: 32
    });

    await expect(
      transport.request({
        method: "GET",
        pathSegments: ["d1", "database"],
        body: { secret: apiToken }
      })
    ).rejects.toMatchObject({ code: "cloudflare_api_invalid_request" });
    await expect(
      transport.request({
        method: "POST",
        pathSegments: ["d1", "database"],
        body: { value: "x".repeat(64) }
      })
    ).rejects.toMatchObject({ code: "cloudflare_api_invalid_request" });
    expect(calls).toBe(0);
  });

  it("rejects invalid and oversized success responses", async () => {
    const invalid = createTransport(() => Promise.resolve(jsonResponse({ success: true })));
    await expect(
      invalid.request({ method: "GET", pathSegments: ["d1", "database"] })
    ).rejects.toMatchObject({ code: "cloudflare_api_invalid_response" });

    const oversized = createCloudflareApiTransport({
      accountId,
      apiToken,
      maxResponseBytes: 32,
      fetch: () => Promise.resolve(jsonResponse({ success: true, result: "x".repeat(100) }))
    });
    await expect(
      oversized.request({ method: "GET", pathSegments: ["d1", "database"] })
    ).rejects.toMatchObject({ code: "cloudflare_api_invalid_response" });
  });

  it("aborts timed-out requests and clears the timer without leaking fetch errors", async () => {
    let cleared = 0;
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      maxGetAttempts: 1,
      timers: {
        set: (callback) => {
          callback();
          return 7;
        },
        clear: (handle) => {
          expect(handle).toBe(7);
          cleared += 1;
        }
      },
      fetch: (_input, init) => {
        expect(init.signal?.aborted).toBe(true);
        return Promise.reject(new Error(`timeout ${apiToken}`));
      }
    });

    const error = await captureApiError(
      transport.request({ method: "GET", pathSegments: ["d1", "database"] })
    );
    expect(error.code).toBe("cloudflare_api_unavailable");
    expect(cleared).toBe(1);
    expect(JSON.stringify(error)).not.toContain(apiToken);
  });

  it("clears the request timer after a successful response", async () => {
    let cleared = 0;
    const transport = createCloudflareApiTransport({
      accountId,
      apiToken,
      timers: {
        set: () => 11,
        clear: (handle) => {
          expect(handle).toBe(11);
          cleared += 1;
        }
      },
      fetch: () => Promise.resolve(jsonResponse({ success: true, result: null }))
    });

    await expect(
      transport.request({ method: "GET", pathSegments: ["d1", "database"] })
    ).resolves.toBeNull();
    expect(cleared).toBe(1);
  });
});

function createTransport(fetch: CloudflareFetch) {
  return createCloudflareApiTransport({ accountId, apiToken, fetch, maxGetAttempts: 1 });
}

function jsonResponse(value: unknown, init?: ResponseInit): Response {
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(value), {
    ...init,
    headers
  });
}

async function captureApiError(promise: Promise<unknown>): Promise<CloudflareApiError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CloudflareApiError) return error;
    throw error;
  }
  throw new Error("expected Cloudflare API request to fail");
}
