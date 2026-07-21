import { access, mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runExtCli, type CliIo, type RollbackClient } from "../src/index.js";
import { renderPluginPackageJson } from "../src/plugin-scaffold.js";

const tempDirs: string[] = [];

describe("ext init", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
    tempDirs.length = 0;
  });

  it("creates the built-in webhook transformer template with least privilege defaults", async () => {
    const root = await createTempDir();
    const target = join(root, "webhook-transformer");
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["init", "--template", "webhook-transformer", "--dir", target],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);

    await expect(readJsonFile(join(target, "package.json"))).resolves.toMatchObject({
      name: "@tenantscript-plugin/webhook-transformer"
    });
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'hooks: [{ name: "webhook.received", type: "transform"'
    );
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      "capabilities: {}"
    );
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'egress: { mode: "deny" }'
    );
    await expect(readFile(join(target, "src", "index.ts"), "utf8")).resolves.toContain(
      '"webhook.received": async (payload, _context) => payload'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      'expect(result).toEqual({ ok: true, value: { id: "evt_1" } })'
    );
    const securityNote = await readFile(join(target, "SECURITY.md"), "utf8");
    expect(securityNote).toContain("untrusted");
    expect(securityNote).toContain("egress");
    expect(securityNote).toContain("production certification");
    expect(stdout).toEqual([
      JSON.stringify({
        name: "webhook-transformer",
        directory: target,
        files: [
          "package.json",
          "tsconfig.json",
          "SECURITY.md",
          "src/manifest.ts",
          "src/index.ts",
          "test/plugin.test.ts"
        ]
      })
    ]);
    expect(stderr).toEqual([]);
  });

  it("applies a safe name override to the webhook transformer template", async () => {
    const root = await createTempDir();
    const target = join(root, "custom-webhook-transformer");

    await expect(
      runExtCli(
        [
          "init",
          "--template",
          "webhook-transformer",
          "--name",
          "custom-webhook-transformer",
          "--dir",
          target
        ],
        rollbackOnlyClient,
        captureIo([], [])
      )
    ).resolves.toBe(0);

    await expect(readJsonFile(join(target, "package.json"))).resolves.toMatchObject({
      name: "@tenantscript-plugin/custom-webhook-transformer"
    });
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'name: "custom-webhook-transformer"'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      'describe("custom-webhook-transformer"'
    );
  });

  it("creates a fail-closed invoice approval template with boundary tests", async () => {
    const root = await createTempDir();
    const target = join(root, "invoice-approval");
    const stdout: string[] = [];

    await expect(
      runExtCli(
        ["init", "--template", "invoice-approval", "--dir", target],
        rollbackOnlyClient,
        captureIo(stdout, [])
      )
    ).resolves.toBe(0);

    await expect(readJsonFile(join(target, "package.json"))).resolves.toMatchObject({
      name: "@tenantscript-plugin/invoice-approval"
    });
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'hooks: [{ name: "invoice.approve", type: "policy"'
    );
    const source = await readFile(join(target, "src", "index.ts"), "utf8");
    expect(source).toContain("const AUTO_APPROVAL_LIMIT_CENTS = 100_000");
    expect(source).toContain("Number.isSafeInteger(payload.amountCents)");
    expect(source).toContain("payload.amountCents >= 0");
    expect(source).toContain("!Array.isArray(payload)");
    expect(source).toContain('decision: "deny", reason: "invalid invoice amount"');
    expect(source).toContain('decision: "deny", reason: "manual approval required"');

    const generatedTest = await readFile(join(target, "test", "plugin.test.ts"), "utf8");
    for (const required of [
      "amountCents: 100_000",
      "amountCents: 100_001",
      "amountCents: -1",
      "amountCents: 1.5",
      "Number.MAX_SAFE_INTEGER + 1",
      "[[], { decision:",
      'decision: "allow"',
      'decision: "deny"',
      "expect(capability).not.toHaveBeenCalled()"
    ]) {
      expect(generatedTest).toContain(required);
    }

    const securityNote = await readFile(join(target, "SECURITY.md"), "utf8");
    expect(securityNote).toContain("untrusted");
    expect(securityNote).toContain("integer cents");
    expect(securityNote).toContain("example threshold");
    expect(securityNote).toContain("production certification");
    expect(stdout).toEqual([
      JSON.stringify({
        name: "invoice-approval",
        directory: target,
        files: [
          "package.json",
          "tsconfig.json",
          "SECURITY.md",
          "src/manifest.ts",
          "src/index.ts",
          "test/plugin.test.ts"
        ]
      })
    ]);
  });

  it("applies a safe name override to the invoice approval template", async () => {
    const root = await createTempDir();
    const target = join(root, "custom-invoice-approval");

    await expect(
      runExtCli(
        [
          "init",
          "--template",
          "invoice-approval",
          "--name",
          "custom-invoice-approval",
          "--dir",
          target
        ],
        rollbackOnlyClient,
        captureIo([], [])
      )
    ).resolves.toBe(0);

    await expect(readJsonFile(join(target, "package.json"))).resolves.toMatchObject({
      name: "@tenantscript-plugin/custom-invoice-approval"
    });
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'name: "custom-invoice-approval"'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      'describe("custom-invoice-approval"'
    );
  });

  it("rejects an unknown template before creating the target directory", async () => {
    const root = await createTempDir();
    const target = join(root, "unknown-template");
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["init", "--template", "unknown-template\nforged-log-line", "--dir", target],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual([
      "invalid init option: unknown --template; available: webhook-transformer, invoice-approval"
    ]);
    await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each([
    ["--hook", "webhook.custom"],
    ["--type", "event"]
  ])(
    "rejects template customization via %s before creating the target directory",
    async (flag, value) => {
      const root = await createTempDir();
      const target = join(root, `conflicting-${flag.slice(2)}`);
      const stderr: string[] = [];

      await expect(
        runExtCli(
          ["init", "--template", "webhook-transformer", "--dir", target, flag, value],
          rollbackOnlyClient,
          captureIo([], stderr)
        )
      ).resolves.toBe(2);

      expect(stderr).toEqual([`invalid init option: ${flag} cannot be used with --template`]);
      await expect(access(target)).rejects.toMatchObject({ code: "ENOENT" });
    }
  );

  it("creates a plugin scaffold with manifest, handler, test, build script, and test script", async () => {
    const root = await createTempDir();
    const target = join(root, "large-invoice-notify");
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(
      runExtCli(
        ["init", "--name", "large-invoice-notify", "--dir", target],
        rollbackOnlyClient,
        captureIo(stdout, stderr)
      )
    ).resolves.toBe(0);

    await expect(readJsonFile(join(target, "package.json"))).resolves.toMatchObject({
      name: "@tenantscript-plugin/large-invoice-notify",
      scripts: {
        build: "tsc --noEmit",
        test: "vitest run"
      }
    });
    await expect(readFile(join(target, "src", "manifest.ts"), "utf8")).resolves.toContain(
      'name: "large-invoice-notify"'
    );
    await expect(readFile(join(target, "src", "index.ts"), "utf8")).resolves.toContain(
      '"invoice.created": async (_payload, _context) => undefined'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      'hookName: "invoice.created"'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      'hookName: "tenantscript.scaffold-undeclared"'
    );
    await expect(readFile(join(target, "test", "plugin.test.ts"), "utf8")).resolves.toContain(
      "expect(capability).not.toHaveBeenCalled()"
    );
    expect(stdout).toEqual([
      JSON.stringify({
        name: "large-invoice-notify",
        directory: target,
        files: [
          "package.json",
          "tsconfig.json",
          "src/manifest.ts",
          "src/index.ts",
          "test/plugin.test.ts"
        ]
      })
    ]);
    expect(stderr).toEqual([]);
  });

  it("pins generated TenantScript dependencies to the exact CLI package version", () => {
    const packageJson = JSON.parse(
      renderPluginPackageJson(
        {
          name: "large-invoice-notify",
          directory: "/tmp/not-written",
          hookName: "invoice.created",
          hookType: "event"
        },
        "1.2.3"
      )
    ) as {
      dependencies: Record<string, string>;
    };

    expect(packageJson.dependencies).toEqual({
      "@tenantscript/manifest": "1.2.3",
      "@tenantscript/plugin-sdk": "1.2.3"
    });
  });

  it.each(["latest", "^1.2.3", "1.2", "1.2.3 || 2.0.0"])(
    "rejects unsafe CLI package version metadata %s",
    (version) => {
      expect(() =>
        renderPluginPackageJson(
          {
            name: "large-invoice-notify",
            directory: "/tmp/not-written",
            hookName: "invoice.created",
            hookType: "event"
          },
          version
        )
      ).toThrow("CLI package version is invalid");
    }
  );

  it("supports transform hook scaffolds", async () => {
    const root = await createTempDir();
    const target = join(root, "payload-transformer");

    await expect(
      runExtCli(
        [
          "init",
          "--name",
          "payload-transformer",
          "--dir",
          target,
          "--hook",
          "webhook.outbound",
          "--type",
          "transform"
        ],
        rollbackOnlyClient,
        captureIo([], [])
      )
    ).resolves.toBe(0);

    await expect(readFile(join(target, "src", "index.ts"), "utf8")).resolves.toContain(
      '"webhook.outbound": async (payload, _context) => payload'
    );
  });

  it("uses a negative-test hook that cannot collide with an accepted hook name", async () => {
    const root = await createTempDir();
    const target = join(root, "collision-safe-plugin");

    await expect(
      runExtCli(
        [
          "init",
          "--name",
          "collision-safe-plugin",
          "--dir",
          target,
          "--hook",
          "invoice.undeclared"
        ],
        rollbackOnlyClient,
        captureIo([], [])
      )
    ).resolves.toBe(0);

    const generatedTest = await readFile(join(target, "test", "plugin.test.ts"), "utf8");
    expect(generatedTest).toContain('hookName: "tenantscript.scaffold-undeclared"');
  });

  it("supports policy hook scaffolds", async () => {
    const root = await createTempDir();
    const target = join(root, "invoice-policy");

    await expect(
      runExtCli(
        [
          "init",
          "--name",
          "invoice-policy",
          "--dir",
          target,
          "--hook",
          "invoice.approve",
          "--type",
          "policy"
        ],
        rollbackOnlyClient,
        captureIo([], [])
      )
    ).resolves.toBe(0);

    await expect(readFile(join(target, "src", "index.ts"), "utf8")).resolves.toContain(
      '"invoice.approve": async (_payload, _context) => ({ decision: "allow" })'
    );
  });

  it("refuses to write into a non-empty directory", async () => {
    const root = await createTempDir();
    const target = join(root, "existing-plugin");
    const stderr: string[] = [];
    await mkdir(target, { recursive: true });
    await writeFile(join(target, "README.md"), "keep me\n");

    await expect(
      runExtCli(
        ["init", "--name", "existing-plugin", "--dir", target],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual([`target directory is not empty: ${target}`]);
  });

  it("rejects unsafe hook names before writing files", async () => {
    const root = await createTempDir();
    const target = join(root, "unsafe-hook");
    const stderr: string[] = [];

    await expect(
      runExtCli(
        [
          "init",
          "--name",
          "unsafe-hook",
          "--dir",
          target,
          "--hook",
          'invoice.created"; throw new Error("boom")'
        ],
        rollbackOnlyClient,
        captureIo([], stderr)
      )
    ).resolves.toBe(2);

    expect(stderr).toEqual([
      "invalid init option: --hook must be dot-separated lowercase segments"
    ]);
  });
});

const rollbackOnlyClient: RollbackClient = {
  rollbackInstallation: () => {
    throw new Error("rollback should not be called");
  }
};

async function createTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "tenantscript-ext-init-"));
  tempDirs.push(dir);
  return dir;
}

async function readJsonFile(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, "utf8")) as unknown;
}

function captureIo(stdout: string[], stderr: string[]): CliIo {
  return {
    stdout: (line) => stdout.push(line),
    stderr: (line) => stderr.push(line)
  };
}
