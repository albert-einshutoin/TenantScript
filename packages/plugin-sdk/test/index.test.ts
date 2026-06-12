import { describe, expect, it } from "vitest";
import { pluginSdkPackage } from "../src/index.js";

describe("plugin-sdk package", () => {
  it("declares its package boundary", () => {
    expect(pluginSdkPackage.name).toBe("@tenantscript/plugin-sdk");
  });
});
