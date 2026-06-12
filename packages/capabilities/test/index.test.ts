import { describe, expect, it } from "vitest";
import { capabilitiesPackage } from "../src/index.js";

describe("capabilities package", () => {
  it("declares its package boundary", () => {
    expect(capabilitiesPackage.name).toBe("@tenantscript/capabilities");
  });
});
