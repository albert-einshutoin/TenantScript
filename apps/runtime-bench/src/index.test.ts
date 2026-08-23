import { describe, expect, it } from "vitest";

import runtimeBench from "./index.js";

describe("runtime benchmark concurrency", () => {
  it.each([
    { name: "same tenant", tenantCount: 1, expectedWorkerIds: 1 },
    { name: "multiple tenants", tenantCount: 4, expectedWorkerIds: 4 }
  ])("runs the fixed $name load concurrently", async ({ tenantCount, expectedWorkerIds }) => {
    const workerIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    const env = {
      LOADER: {
        get: (id: string) => {
          workerIds.push(id);
          return {
            getEntrypoint: () => ({
              fetch: async (request: Request) => {
                active += 1;
                maxActive = Math.max(maxActive, active);
                const payload: {
                  headers: Record<string, string>;
                  body: Record<string, unknown>;
                } = await request.json();
                await new Promise((resolve) => setTimeout(resolve, 1));
                active -= 1;
                return Response.json({
                  headers: payload.headers,
                  body: { ...payload.body, transformedBy: "runtime-bench" }
                });
              }
            })
          };
        },
        load: () => {
          throw new Error("load must not be used for cached concurrency scenarios");
        }
      }
    };

    const response = await runtimeBench.fetch(
      new Request(
        `https://runtime.example/bench?mode=get&iterations=8&warmup=0&tenants=${String(tenantCount)}&concurrency=4`
      ),
      env
    );
    const body: Record<string, unknown> = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      mode: "get",
      iterations: 8,
      measured: 8,
      warmup: 0,
      tenantCount,
      concurrency: 4,
      loaderCalls: tenantCount
    });
    expect(new Set(workerIds).size).toBe(expectedWorkerIds);
    expect(maxActive).toBe(4);
  });
});
