import { describe, expect, it } from "vitest";
import { exampleSaasApp } from "../src/index.js";

describe("example-saas app", () => {
  it("declares its app boundary", () => {
    expect(exampleSaasApp.name).toBe("@tenantscript/example-saas");
  });
});
