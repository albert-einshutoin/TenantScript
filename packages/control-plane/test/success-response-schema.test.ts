import { readFile } from "node:fs/promises";
import { URL, fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  ADMIN_HTTP_ENDPOINT_CONTRACTS,
  CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS,
  type AdminHttpEndpointContract
} from "../src/http-api.js";

describe("Control Plane success response schema catalog", () => {
  it("covers every public endpoint method with either JSON or no-content", () => {
    const coveredMethods: string[] = [];

    for (const contract of ADMIN_HTTP_ENDPOINT_CONTRACTS) {
      const publicContract: AdminHttpEndpointContract = contract;
      expect(Object.keys(publicContract.success).sort()).toEqual(
        [...publicContract.methods].sort()
      );

      for (const method of publicContract.methods) {
        const success = publicContract.success[method];
        expect(success).toBeDefined();
        if (success === undefined) throw new Error("missing success response contract");
        coveredMethods.push(`${method} ${publicContract.path}`);

        if (success.body === "none") {
          expect(success.status).toBe(204);
          continue;
        }

        expect(success.status).toBeGreaterThanOrEqual(200);
        expect(success.status).toBeLessThan(300);
        expect(CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS[success.schema]).toBeDefined();
      }
    }

    expect(coveredMethods).toHaveLength(19);
    expect(new Set(coveredMethods).size).toBe(19);
    expect(Object.keys(CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS)).toHaveLength(18);
  });

  it("exactly matches the committed public artifact and cannot mutate at runtime", async () => {
    const artifact: unknown = JSON.parse(
      await readFile(
        fileURLToPath(
          new URL(
            "../../../docs/reference/control-plane-success-responses.schema.json",
            import.meta.url
          )
        ),
        "utf8"
      )
    );

    expect(artifact).toEqual({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS
    });
    expect(Object.isFrozen(CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS)).toBe(true);
    expect(Object.isFrozen(CONTROL_PLANE_SUCCESS_RESPONSE_SCHEMAS.dashboard)).toBe(true);
  });
});
