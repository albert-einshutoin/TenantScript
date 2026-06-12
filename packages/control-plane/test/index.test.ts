import { describe, expect, it } from "vitest";
import { controlPlanePackage } from "../src/index.js";

describe("control-plane package", () => {
  it("declares its package boundary", () => {
    expect(controlPlanePackage.name).toBe("@tenantscript/control-plane");
  });
});
