import { describe, expect, it } from "vitest";
import { manifestPackage } from "../src/index.js";

describe("manifest package", () => {
  it("declares its package boundary", () => {
    expect(manifestPackage.name).toBe("@tenantscript/manifest");
  });
});
