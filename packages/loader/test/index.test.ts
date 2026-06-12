import { describe, expect, it } from "vitest";
import { loaderPackage } from "../src/index.js";

describe("loader package", () => {
  it("declares its package boundary", () => {
    expect(loaderPackage.name).toBe("@tenantscript/loader");
  });
});
