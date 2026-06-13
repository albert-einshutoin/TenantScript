import { describe, expect, it } from "vitest";
import { createInMemoryProxyMappingStore } from "../src/index.js";

describe("proxy security suite", () => {
  it("rejects proxy mappings whose destination is outside the allowlist", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["https://origin.example.com"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/evil",
        tenantId: "tenant_1",
        destinationUrl: "https://attacker.example.net/collect",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow(
      "proxy destination https://attacker.example.net/collect is outside the allowlist"
    );
  });

  it("rejects link-local destinations even when written as URLs", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["http://169.254.169.254"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/metadata",
        tenantId: "tenant_1",
        destinationUrl: "http://169.254.169.254/latest/meta-data",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow(
      "proxy destination http://169.254.169.254/latest/meta-data is not a public http(s) URL"
    );
  });

  it("rejects private IPv6 destinations", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["http://[::1]", "http://[fd00::1]", "http://[fe80::1]"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/loopback",
        tenantId: "tenant_1",
        destinationUrl: "http://[::1]/internal",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy destination http://[::1]/internal is not a public http(s) URL");

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/unique-local",
        tenantId: "tenant_1",
        destinationUrl: "http://[fd00::1]/internal",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy destination http://[fd00::1]/internal is not a public http(s) URL");

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/link-local-v6",
        tenantId: "tenant_1",
        destinationUrl: "http://[fe80::1]/internal",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy destination http://[fe80::1]/internal is not a public http(s) URL");
  });

  it("rejects malformed inbound paths and destination URLs", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["https://origin.example.com"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "hooks/stripe",
        tenantId: "tenant_1",
        destinationUrl: "https://origin.example.com/stripe",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy inbound path must start with /");

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/bad-url",
        tenantId: "tenant_1",
        destinationUrl: "not a url",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy destination not a url is not a valid URL");
  });

  it("rejects non-http and local destinations", async () => {
    const store = createInMemoryProxyMappingStore({
      allowedDestinationOrigins: ["ftp://origin.example.com", "http://localhost"]
    });

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/ftp",
        tenantId: "tenant_1",
        destinationUrl: "ftp://origin.example.com/file",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow(
      "proxy destination ftp://origin.example.com/file is not a public http(s) URL"
    );

    await expect(
      store.upsertProxyMapping({
        inboundPath: "/hooks/localhost",
        tenantId: "tenant_1",
        destinationUrl: "http://localhost/internal",
        transformHookName: "webhook.proxy.transform"
      })
    ).rejects.toThrow("proxy destination http://localhost/internal is not a public http(s) URL");
  });
});
