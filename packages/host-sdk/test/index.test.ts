import { describe, expect, it } from "vitest";
import { hostSdkPackage } from "../src/index.js";

describe("host-sdk package", () => {
  it("declares its package boundary", () => {
    expect(hostSdkPackage.name).toBe("@tenantscript/host-sdk");
  });
});
