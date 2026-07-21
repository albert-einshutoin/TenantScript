import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { bundlePlugin } from "@tenantscript/loader";
import { afterEach, describe, expect, it } from "vitest";
import { auditPluginPackage, runExtCli, type CliIo, type RollbackClient } from "../src/index.js";
import { readCliPackageVersion } from "../src/plugin-scaffold.js";

const tempDirs: string[] = [];

describe("plugin audit", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("accepts a manifest and package pinned to the audited SDK version", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3"
      })
    ).toEqual({ version: 1, passed: true, findings: [] });
  });

  it("accepts a statically declared capability used through the broker", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('await context.capability("slack.send", {});')
      })
    ).toEqual({ version: 1, passed: true, findings: [] });
  });

  it("audits handler exports lowered by the production bundle pipeline", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    await writeFile(
      entry,
      'export const handlers = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };'
    );
    const bundle = await bundlePlugin(entry);

    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: bundle.code
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("audits plugin dispatch lowered by the production bundle pipeline", async () => {
    const root = await createTempDir();
    const entry = join(root, "plugin.ts");
    await writeFile(
      entry,
      'export const plugin = { dispatch(request) { return request.context.capability("slack.send", {}); } };'
    );
    const bundle = await bundlePlugin(entry);

    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: bundle.code
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects capability calls through renamed and destructured context bindings", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "definePlugin({ handlers: {",
          'event: async (_payload, ctx) => { await ctx.capability("github.issue.create", {}); const { capability: invoke } = ctx; invoke("email.send", {}); },',
          'policy: async (_payload, { capability }) => capability("storage.read", {})',
          "} });"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);
  });

  it("does not treat an unrelated capability method as an SDK broker call", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: 'function helper(_payload, client) { client.capability("slack.send", {}); }'
      }).findings
    ).toEqual([
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);
  });

  it("detects renamed context bindings in top-level exported handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.handlers = { event: async (_payload, runtime) => runtime.capability("slack.send", {}) };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects renamed context bindings in object-method handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.handlers = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects renamed context bindings in quoted object-method handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.handlers = { "invoice.created"(_payload, ctx) { return ctx.capability("slack.send", {}); } };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects renamed context bindings in async quoted object-method handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.handlers = { async "invoice.created"(_payload, ctx) { return ctx.capability("slack.send", {}); } };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects handlers inside a direct CommonJS module export", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'module.exports = { handlers: { event(_payload, ctx) { return ctx.capability("slack.send", {}); } } };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects handler maps referenced by definePlugin", () => {
    const sources = [
      [
        'const handlers = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };',
        "export const plugin = definePlugin({ manifest: {}, handlers });"
      ].join("\n"),
      [
        'const pluginHandlers = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };',
        "export const plugin = definePlugin({ manifest: {}, handlers: pluginHandlers });"
      ].join("\n")
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects renamed context bindings in referenced arrow handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'const handler = async (_payload, ctx) => ctx.capability("slack.send", {});',
          "export const handlers = { event: handler };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects referenced handlers declared after another variable declarator", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'const noop = () => undefined, event = (_payload, ctx) => ctx.capability("slack.send", {});',
          "exports.handlers = { event };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("does not treat a comma assignment inside an initializer as a declarator", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "let event;",
          'const noop = (undefined, event = (_payload, ctx) => ctx.capability("slack.send", {}));',
          "exports.handlers = { event };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("detects optional member and destructured capability calls", () => {
    const sources = [
      'export const handlers = { event(_payload, ctx) { return ctx.capability?.("slack.send", {}); } };',
      'export const handlers = { event(_payload, { capability }) { return capability?.("slack.send", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects bracketed capability calls on the handler context", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('context["capability"]("slack.send", {});')
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("decodes escaped broker and egress identifiers", () => {
    const sources = [
      String.raw`context.\u0063apability("admin.delete", {}); globalThis.\u0066etch("https://example.com");`,
      String.raw`context.\u{63}apability("admin.delete", {}); globalThis.f\u0065tch("https://example.com");`
    ];

    for (const source of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode: handlerBundle(source)
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
        finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
      ]);
    }
  });

  it("detects capability and egress calls invoked through Function.prototype.call", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle(
          'context.capability.call(undefined, "admin.delete", {}); globalThis.fetch.call(undefined, "https://example.com");'
        )
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("detects capability and egress calls invoked through Function.prototype.apply", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle(
          'context.capability.apply(undefined, ["admin.delete", {}]); globalThis.fetch.apply(undefined, ["https://example.com"]);'
        )
      }).findings
    ).toEqual([
      finding(
        "bundle_capability_usage_dynamic",
        "warning",
        "bundle.capabilityCalls.*",
        "heuristic"
      ),
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("detects parenthesized indirect capability calls", () => {
    const sources = [
      handlerBundle('(0, context.capability)("admin.delete", {});'),
      'export const handlers = { event(_payload, { capability }) { return (0, capability)("admin.delete", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects parenthesized indirect global fetch calls", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('(0, globalThis.fetch)("https://example.com");')
      }).findings
    ).toEqual([
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("detects capabilities in bracketed CommonJS handler exports", () => {
    const sources = [
      'exports["handlers"] = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };',
      'module.exports["handlers"] = { event(_payload, ctx) { return ctx.capability("slack.send", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capability calls in computed handler methods", () => {
    const sources = [
      'exports.handlers = { ["invoice.created"](_payload, ctx) { return ctx.capability("admin.delete", {}); } };',
      'module.exports.handlers = { async ["invoice.created"](_payload, ctx) { return ctx.capability("admin.delete", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in CommonJS-exported handler bindings", () => {
    const sources = [
      'const legacyHandlers = { event(_payload, ctx) { return ctx.capability("admin.delete", {}); } }; exports.handlers = legacyHandlers;',
      'const handlers = { event(_payload, ctx) { return ctx.capability("admin.delete", {}); } }; module.exports.handlers = handlers;'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in runtime-supported plugin dispatch exports", () => {
    const sources = [
      'module.exports = { dispatch(request) { return request.context.capability("slack.send", {}); } };',
      'exports.plugin = { dispatch: async ({ context }) => context.capability("slack.send", {}) };',
      'module.exports = { plugin: { dispatch(request) { return request.context.capability("slack.send", {}); } } };',
      'function dispatch(request) { return request.context.capability("slack.send", {}); } exports.plugin = { dispatch };',
      'const dispatch = request => request.context.capability("slack.send", {}); exports.plugin = { dispatch };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in computed plugin dispatch fields", () => {
    const sources = [
      'exports.plugin = { ["dispatch"](request) { return request.context.capability("admin.delete", {}); } };',
      'module.exports = { plugin: { async ["dispatch"](request) { return request.context.capability("admin.delete", {}); } } };',
      'exports.plugin = { ["dispatch"]: request => request.context.capability("admin.delete", {}) };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in mutated plugin dispatch exports", () => {
    const sources = [
      'exports.plugin = {}; exports.plugin.dispatch = ({ context }) => context.capability("admin.delete", {});',
      'module.exports.plugin = {}; module.exports.plugin.dispatch = function(request) { return request.context.capability("admin.delete", {}); };',
      'const plugin = {}; exports.plugin = plugin; plugin["dispatch"] = request => request.context.capability("admin.delete", {});',
      'module.exports = {}; module.exports["dispatch"] = request => request.context.capability("admin.delete", {});'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in CommonJS-exported plugin bindings", () => {
    const sources = [
      'const plugin = { dispatch(request) { return request.context.capability("admin.delete", {}); } }; exports.plugin = plugin;',
      'const defaultPlugin = { dispatch(request) { return request.context.capability("admin.delete", {}); } }; module.exports.default = defaultPlugin;',
      'const rootPlugin = { dispatch(request) { return request.context.capability("admin.delete", {}); } }; module.exports = rootPlugin;'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects capabilities in bracketed CommonJS plugin exports", () => {
    const sources = [
      'exports["plugin"] = { dispatch(request) { return request.context.capability("admin.delete", {}); } };',
      'module.exports["default"] = { dispatch(request) { return request.context.capability("admin.delete", {}); } };',
      'module.exports = { ["plugin"]: { dispatch(request) { return request.context.capability("admin.delete", {}); } } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects single-parameter dispatch arrows", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.plugin = { dispatch: request => request.context.capability("slack.send", {}) };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects bracketed context access in dispatch handlers", () => {
    const sources = [
      'exports.plugin = { dispatch(request) { return request["context"].capability("admin.delete", {}); } };',
      'exports.plugin = { dispatch(request) { return request["context"]["capability"]("admin.delete", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects context aliases introduced inside dispatch handlers", () => {
    const sources = [
      'exports.plugin = { dispatch(request) { const { context } = request; return context.capability("slack.send", {}); } };',
      'exports.plugin = { dispatch(request) { const { context: broker } = request; return broker.capability("slack.send", {}); } };',
      'exports.plugin = { dispatch(request) { const broker = request.context; return broker.capability("slack.send", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("detects computed destructured broker aliases", () => {
    const sources = [
      handlerBundle('const { ["capability"]: cap } = context; return cap("admin.delete", {});'),
      'exports.plugin = { dispatch(request) { const { ["context"]: broker } = request; const { ["capability"]: cap } = broker; return cap("admin.delete", {}); } };'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
      ]);
    }
  });

  it("bounds dispatch context aliases to their declaration block", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "exports.plugin = { dispatch(request) {",
          '  { const { context } = request; context.capability("slack.send", {}); }',
          '  const context = client; context.capability("github.issue.create", {});',
          "} };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("detects nested-destructured dispatch arrows", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          'exports.plugin = { dispatch: ({ context: { capability } }) => capability("slack.send", {}) };'
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("tokenizes executable template expressions inside handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('`${context.capability("slack.send", {})}`;')
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("treats a no-substitution template capability name as exact", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle("context.capability(`slack.send`, {});")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("treats an interpolated template capability name as dynamic", () => {
    const manifest = validManifest();
    manifest.capabilities = { "send.message": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('context.capability(`slack.${"send.message"}`, {});')
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("treats a capability argument with a literal prefix as dynamic", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('context.capability("slack.send" + suffix, {});')
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("detects renamed context bindings in referenced function-expression handlers", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'const handler = async function (_payload, ctx) { return ctx.capability("slack.send", {}); };',
          "export const handlers = { event: handler };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("detects renamed context bindings in shorthand handler exports", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'async function event(_payload, ctx) { return ctx.capability("slack.send", {}); }',
          "export const handlers = { event };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("does not treat an unrelated binding named context as the SDK broker", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'const context = { capability: () => "not-the-sdk" };',
          'context.capability("slack.send", {});',
          "export const handlers = { event(_payload, runtime) { return runtime; } };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("does not treat unrelated objects named handlers as plugin dispatch surfaces", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'const ui = { handlers: { click(_payload, ctx) { return ctx.capability("admin.delete", {}); } } };',
          "export const handlers = { event(_payload, runtime) { return runtime; } };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("keeps top-level callable bindings when nested declarations reuse the name", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          'function event(_payload, ctx) { return ctx.capability("slack.send", {}); }',
          "function helper() { function event(_payload, ctx) { return ctx; } return event; }",
          "export const handlers = { event };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("respects function-scoped var shadows in nested helpers", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "export const handlers = { event(_payload, ctx) {",
          "  function helper() {",
          "    if (ready) { var ctx = client; }",
          '    return ctx.capability("admin.delete", {});',
          "  }",
          '  return ctx.capability("slack.send", {});',
          "} };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("does not reuse a handler context receiver name outside its handler body", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "export const handlers = { event(_payload, ctx) { return ctx; } };",
          'function helper(ctx) { return ctx.capability("slack.send", {}); }'
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("does not reuse a handler context receiver name in a shadowing nested function", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "export const handlers = { event(_payload, ctx) {",
          'function helper(ctx) { return ctx.capability("slack.send", {}); }',
          "return helper({ capability: () => undefined });",
          "} };"
        ].join("\n")
      }).findings
    ).toEqual([]);
  });

  it("does not reuse a handler context receiver across nested method parameters", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };
    const helpers = [
      'const helper = { run(ctx) { return ctx.capability("admin.delete", {}); } };',
      'class Helper { run(ctx) { return ctx.capability("admin.delete", {}); } }'
    ];

    for (const helper of helpers) {
      expect(
        auditPluginPackage({
          manifest,
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode: [
            "export const handlers = { event(_payload, ctx) {",
            helper,
            'return ctx.capability("slack.send", {});',
            "} };"
          ].join("\n")
        }).findings
      ).toEqual([]);
    }
  });

  it("does not reuse a handler context receiver across destructured callable parameters", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };
    const helpers = [
      'function helper({ ctx }) { return ctx.capability("admin.delete", {}); }',
      'const helper = ({ ctx }) => ctx.capability("admin.delete", {});'
    ];

    for (const helper of helpers) {
      expect(
        auditPluginPackage({
          manifest,
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode: [
            "export const handlers = { event(_payload, ctx) {",
            helper,
            'return ctx.capability("slack.send", {});',
            "} };"
          ].join("\n")
        }).findings
      ).toEqual([]);
    }
  });

  it("distinguishes destructured property names from callable bindings", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: [
          "export const handlers = { event(_payload, ctx) {",
          'function helper({ ctx: unrelated }) { return ctx.capability("admin.delete", {}); }',
          "return helper({ ctx: undefined });",
          "} };"
        ].join("\n")
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact")
    ]);
  });

  it("does not reuse a handler context receiver across block-scoped shadows", () => {
    const bodies = [
      '{ const ctx = fake; ctx.capability("slack.send", {}); }',
      '{ let ctx = fake; ctx.capability("slack.send", {}); }',
      '{ class ctx { static capability() {} } ctx.capability("slack.send", {}); }',
      'try { throw fake; } catch (ctx) { ctx.capability("slack.send", {}); }'
    ];

    for (const body of bodies) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode: `export const handlers = { event(_payload, ctx) { ${body} } };`
        }).findings
      ).toEqual([]);
    }
  });

  it("keeps malformed delimiter analysis within a bounded CPU budget", () => {
    const startedAt = performance.now();
    const report = auditPluginPackage({
      manifest: validManifest(),
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode: "{".repeat(20_000)
    });

    expect(report).toEqual({ version: 1, passed: true, findings: [] });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("keeps repeated receiver scope lookups within a bounded CPU budget", () => {
    const handlers = Array.from(
      { length: 2_000 },
      (_, index) => `hook${String(index)}(_payload, ctx) { return ctx; }`
    ).join(",");
    const unrelatedCalls = 'ctx.capability("slack.send", {});'.repeat(2_000);
    const startedAt = performance.now();
    const report = auditPluginPackage({
      manifest: validManifest(),
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode: `export const handlers = { ${handlers} }; ${unrelatedCalls}`
    });

    expect(report).toEqual({ version: 1, passed: true, findings: [] });
    expect(performance.now() - startedAt).toBeLessThan(1_000);
  });

  it("decodes escaped static capability names before comparing grants", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle(
          String.raw`context.capability("\u0067ithub\x2eissue\u{2e}create", {});`
        )
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);
  });

  it("rejects a static capability literal that the manifest schema cannot grant", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('context.capability("Slack", {});')
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);
  });

  it("keeps malformed escaped capability literals in the dynamic boundary", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle(String.raw`context.capability("slack\xZZsend", {});`)
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("keeps malformed braced Unicode escapes in tagged templates within the dynamic boundary", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode:
          "export const handlers = { event(_payload, ctx) { return ctx.capability(tag`\\u{}`, {}); } };"
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("reports unused, undeclared, dynamic, and direct egress bundle risks", () => {
    const manifest = validManifest();
    manifest.capabilities = { "slack.send": {}, "email.send": {} };

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle(
          'context.capability("slack.send", {}); context.capability("github.issue.create", {}); fetch("https://example.invalid");'
        )
      }).findings
    ).toEqual([
      finding("bundle_capability_undeclared", "error", "bundle.capabilityCalls.*", "exact"),
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic"),
      finding("bundle_grant_potentially_unused", "warning", "manifest.capabilities.*", "heuristic")
    ]);

    expect(
      auditPluginPackage({
        manifest,
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle("context.capability(capabilityName, {});")
      }).findings
    ).toEqual([
      finding("bundle_capability_usage_dynamic", "warning", "bundle.capabilityCalls.*", "heuristic")
    ]);
  });

  it("keeps bundle finding order stable when call order changes", () => {
    const manifest = validManifest();
    manifest.capabilities = { "email.send": {} };
    const request = {
      manifest,
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    };
    const first = auditPluginPackage({
      ...request,
      bundleCode: handlerBundle(
        'fetch("https://example.invalid"); context.capability("slack.send", {});'
      )
    });
    const second = auditPluginPackage({
      ...request,
      bundleCode: handlerBundle(
        'context.capability("slack.send", {}); fetch("https://example.invalid");'
      )
    });

    expect(first).toEqual(second);
  });

  it("ignores call-shaped text in comments and strings without reflecting capability names", () => {
    const manifest = validManifest();
    manifest.capabilities = { "secret.sentinel": {} };
    const bundleCode = handlerBundle(
      [
        '// fetch("https://example.invalid")',
        "const note = 'context.capability(\"secret.sentinel\", {})';",
        "const pattern = /fetch\\(/u;",
        "const hasFetch = () => /fetch\\(/u.test(note);",
        'context.capability("secret.sentinel", {});'
      ].join("\n")
    );

    const report = auditPluginPackage({
      manifest,
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode
    });

    expect(report.findings).toEqual([]);
    expect(JSON.stringify(report)).not.toContain("secret.sentinel");
  });

  it("ignores regex statements after control-flow conditions", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: handlerBundle('if (ok) /context\\.capability\\("admin.delete"\\)/.test(note);')
      }).findings
    ).toEqual([]);
  });

  it("detects global fetch while ignoring unrelated fetch methods and block comments", () => {
    const report = auditPluginPackage({
      manifest: validManifest(),
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3",
      bundleCode: [
        '/* globalThis.fetch("https://comment.invalid") */',
        'client.fetch("https://broker.invalid");',
        'globalThis.fetch("https://direct.invalid");'
      ].join("\n")
    });

    expect(report.findings).toEqual([
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("detects bracketed global fetch calls", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(),
        expectedSdkVersion: "1.2.3",
        bundleCode: 'globalThis["fetch"]("https://direct.invalid");'
      }).findings
    ).toEqual([
      finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
    ]);
  });

  it("detects worker-global self fetch calls", () => {
    const sources = [
      'self.fetch("https://direct.invalid");',
      'self["fetch"]("https://direct.invalid");',
      "self.fetch`https://direct.invalid`;"
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
      ]);
    }
  });

  it("detects optional global fetch calls", () => {
    const sources = [
      'fetch?.("https://direct.invalid");',
      'globalThis.fetch?.("https://direct.invalid");'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
      ]);
    }
  });

  it("detects tagged-template global fetch calls", () => {
    const sources = [
      "fetch`https://direct.invalid`;",
      "globalThis.fetch`https://direct.invalid`;",
      'globalThis["fetch"]`https://direct.invalid`;'
    ];

    for (const bundleCode of sources) {
      expect(
        auditPluginPackage({
          manifest: validManifest(),
          packageJson: validPackageJson(),
          expectedSdkVersion: "1.2.3",
          bundleCode
        }).findings
      ).toEqual([
        finding("bundle_direct_egress_detected", "warning", "bundle.egressCalls.*", "heuristic")
      ]);
    }
  });

  it("reports deterministic exact findings without reflecting input values", () => {
    const secretSentinel = "secret_SENTINEL_do_not_reflect";
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        name: secretSentinel,
        limits: { cpuMs: 51, timeoutMs: 501 }
      },
      packageJson: { scripts: {}, dependencies: {} },
      expectedSdkVersion: "1.2.3"
    });

    expect(report).toEqual({
      version: 1,
      passed: false,
      findings: [
        finding("manifest_invalid", "error", "manifest.name"),
        finding("plugin_sdk_missing", "error", "package.dependencies.@tenantscript/plugin-sdk"),
        finding("plugin_tests_missing", "error", "package.scripts.test")
      ]
    });
    expect(JSON.stringify(report)).not.toContain(secretSentinel);
  });

  it("redacts user-controlled manifest keys from finding paths", () => {
    const secretSentinel = "secret_SENTINEL_capability_key";
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        capabilities: { [secretSentinel]: {} }
      },
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    });

    expect(report.findings).toEqual([
      finding("manifest_invalid", "error", "manifest.capabilities.*")
    ]);
    expect(JSON.stringify(report)).not.toContain(secretSentinel);
  });

  it("redacts user-controlled keys even when they match structural path names", () => {
    const report = auditPluginPackage({
      manifest: {
        ...validManifest(),
        capabilities: { version: {} },
        configSchema: {
          properties: { version: { type: "boolean", default: "invalid" } },
          required: []
        }
      },
      packageJson: validPackageJson(),
      expectedSdkVersion: "1.2.3"
    });

    expect(report.findings).toEqual([
      finding("manifest_invalid", "error", "manifest.capabilities.*"),
      finding("manifest_invalid", "error", "manifest.configSchema.properties.*.default")
    ]);
  });

  it.each(["latest", "^1.2.3", "workspace:*", "1.2.3 || 2.0.0"])(
    "rejects the unpinned SDK declaration %s",
    (version) => {
      const report = auditPluginPackage({
        manifest: validManifest(),
        packageJson: validPackageJson(version),
        expectedSdkVersion: "1.2.3"
      });

      expect(report.findings).toEqual([
        finding(
          "plugin_sdk_version_unpinned",
          "error",
          "package.dependencies.@tenantscript/plugin-sdk"
        )
      ]);
    }
  );

  it("separates SDK mismatch errors from limit review warnings", () => {
    const report = auditPluginPackage({
      manifest: { ...validManifest(), limits: { cpuMs: 51, timeoutMs: 501 } },
      packageJson: validPackageJson("1.2.4"),
      expectedSdkVersion: "1.2.3"
    });

    expect(report).toEqual({
      version: 1,
      passed: false,
      findings: [
        finding(
          "plugin_sdk_version_mismatch",
          "error",
          "package.dependencies.@tenantscript/plugin-sdk"
        ),
        finding("runtime_cpu_limit_high", "warning", "manifest.limits.cpuMs"),
        finding("runtime_timeout_limit_high", "warning", "manifest.limits.timeoutMs")
      ]
    });
  });

  it("accepts one exact development SDK declaration and rejects duplicate ownership", () => {
    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: {
          scripts: { test: "vitest run" },
          devDependencies: { "@tenantscript/plugin-sdk": "1.2.3" }
        },
        expectedSdkVersion: "1.2.3"
      }).findings
    ).toEqual([]);

    expect(
      auditPluginPackage({
        manifest: validManifest(),
        packageJson: {
          ...validPackageJson(),
          devDependencies: { "@tenantscript/plugin-sdk": "1.2.3" }
        },
        expectedSdkVersion: "1.2.3"
      }).findings
    ).toEqual([
      finding(
        "plugin_sdk_declaration_ambiguous",
        "error",
        "package.dependencies.@tenantscript/plugin-sdk"
      )
    ]);
  });

  it("returns exit zero for warning-only reports and exit one for errors", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const cliVersion = await readCliPackageVersion();
    await writeFile(
      manifest,
      JSON.stringify({ ...validManifest(), limits: { cpuMs: 51, timeoutMs: 501 } })
    );
    await writeFile(packageJson, JSON.stringify(validPackageJson(cliVersion)));
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({ version: 1, passed: true });
    expect(stderr).toEqual([]);

    await writeFile(packageJson, JSON.stringify({ dependencies: {} }));
    stdout.length = 0;
    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(1);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({ version: 1, passed: false });
  });

  it("accepts bounded bundle input and rejects undeclared static capability calls", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const bundle = join(root, "plugin.js");
    const cliVersion = await readCliPackageVersion();
    await writeFile(manifest, JSON.stringify(validManifest()));
    await writeFile(packageJson, JSON.stringify(validPackageJson(cliVersion)));
    await writeFile(bundle, handlerBundle('context.capability("slack.send", {});'));
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson, "--bundle", bundle],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(1);
    expect(JSON.parse(stdout[0] ?? "null")).toMatchObject({
      version: 1,
      passed: false,
      findings: [{ code: "bundle_capability_undeclared", certainty: "exact" }]
    });
    expect(stderr).toEqual([]);
  });

  it.each([
    ["oversized", "x".repeat(4_194_304 + 1)],
    ["binary", Buffer.from([0, 1, 2, 3])]
  ])("rejects %s bundle input without reflecting content", async (_name, bundleContent) => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const bundle = join(root, "plugin.js");
    await writeFile(manifest, JSON.stringify(validManifest()));
    await writeFile(packageJson, JSON.stringify(validPackageJson("0.0.0")));
    await writeFile(bundle, bundleContent);
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson, "--bundle", bundle],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);
  });

  it("accepts a bundle above the former audit cap but within the runtime artifact limit", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    const bundle = join(root, "plugin.js");
    await writeFile(manifest, JSON.stringify(validManifest()));
    await writeFile(packageJson, JSON.stringify(validPackageJson("0.0.0")));
    await writeFile(bundle, " ".repeat(512 * 1024 + 1));
    const stdout: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson, "--bundle", bundle],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);
    expect(JSON.parse(stdout[0] ?? "null")).toEqual({ version: 1, passed: true, findings: [] });
  });

  it.each([
    ["missing manifest", ["audit", "--package", "package.json"]],
    [
      "unknown flag",
      ["audit", "--manifest", "manifest.json", "--package", "package.json", "--token", "secret"]
    ],
    [
      "duplicate flag",
      ["audit", "--manifest", "a.json", "--manifest", "b.json", "--package", "package.json"]
    ],
    [
      "duplicate optional bundle",
      [
        "audit",
        "--manifest",
        "manifest.json",
        "--package",
        "package.json",
        "--bundle",
        "a.js",
        "--bundle",
        "b.js"
      ]
    ]
  ])("rejects %s as usage without reflecting values", async (_name, argv) => {
    const stderr: string[] = [];
    await expect(runExtCli(argv, rollbackOnlyClient, captureIo([], stderr))).resolves.toBe(2);
    expect(stderr).toEqual(["invalid audit options"]);
    expect(stderr.join(" ")).not.toContain("secret");
  });

  it("rejects malformed and oversized input without reflecting file content", async () => {
    const root = await createTempDir();
    const manifest = join(root, "manifest.json");
    const packageJson = join(root, "package.json");
    await writeFile(manifest, "secret-sentinel-malformed");
    await writeFile(packageJson, JSON.stringify(validPackageJson("0.0.0")));
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);

    await writeFile(manifest, JSON.stringify({ padding: "x".repeat(70_000) }));
    stderr.length = 0;
    await expect(
      runExtCli(
        ["audit", "--manifest", manifest, "--package", packageJson],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);
    expect(stderr).toEqual(["plugin audit input is invalid"]);
  });
});

function handlerBundle(body: string): string {
  return `export const handlers = { event(_payload, context) { ${body} } };`;
}

function validManifest(): Record<string, unknown> {
  return {
    name: "invoice-notify",
    version: "1.0.0",
    hooks: [
      {
        name: "invoice.created",
        type: "event",
        timeoutMs: 500,
        schemaVersionRange: "^1.0.0"
      }
    ],
    capabilities: {},
    configSchema: { properties: {}, required: [] },
    egress: { mode: "deny" },
    limits: { cpuMs: 50, timeoutMs: 500 }
  };
}

function validPackageJson(version = "1.2.3"): Record<string, unknown> {
  return {
    scripts: { test: "vitest run" },
    dependencies: { "@tenantscript/plugin-sdk": version }
  };
}

function finding(
  code: string,
  severity: "error" | "warning",
  path: string,
  certainty: "exact" | "heuristic" = "exact"
) {
  const messages: Record<string, string> = {
    bundle_capability_undeclared:
      "bundle contains a static capability call without a matching manifest grant",
    bundle_capability_usage_dynamic:
      "bundle uses a dynamic capability name that cannot be compared with manifest grants",
    bundle_direct_egress_detected:
      "bundle contains a direct fetch call that requires egress bypass review",
    bundle_grant_potentially_unused:
      "manifest grant has no matching static capability call in the bundle",
    manifest_invalid: "manifest does not satisfy the closed TenantScript schema",
    plugin_sdk_missing: "plugin SDK dependency is required",
    plugin_sdk_declaration_ambiguous:
      "plugin SDK must be declared in exactly one dependency section",
    plugin_sdk_version_mismatch: "plugin SDK version does not match the auditing CLI version",
    plugin_sdk_version_unpinned: "plugin SDK dependency must use an exact version",
    plugin_tests_missing: "package must define a non-empty test script",
    runtime_cpu_limit_high: "CPU limit exceeds the scaffold review baseline",
    runtime_timeout_limit_high: "timeout limit exceeds the scaffold review baseline"
  };
  const message = messages[code];
  if (message === undefined) throw new Error(`missing test message for ${code}`);
  return { code, severity, certainty, path, message };
}

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-plugin-audit-"));
  tempDirs.push(dir);
  return dir;
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
