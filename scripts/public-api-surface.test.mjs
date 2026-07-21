import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import {
  checkPublicApiSurface,
  collectPublicApiSurface,
  serializePublicApiSurface
} from "./public-api-surface.mjs";

const temporaryDirectories = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true }))
  );
});

test("collects public package exports and REST contracts deterministically", async () => {
  const root = await createFixtureRepository();

  assert.deepEqual(await collectPublicApiSurface(root), {
    version: 2,
    packages: [
      {
        name: "@fixture/control-plane",
        subpaths: [
          {
            subpath: ".",
            exports: [
              { name: "PublicType", kind: "type" },
              { name: "publicValue", kind: "value" }
            ]
          }
        ]
      }
    ],
    controlPlaneRest: [
      {
        id: "session",
        path: "/v1/session",
        methods: ["GET"],
        isolation: "identity",
        success: [{ method: "GET", status: 200, body: "json", schema: "session" }]
      }
    ],
    controlPlaneCallbacks: [
      {
        id: "slackOAuthCallback",
        path: "/v1/provider-callbacks/slack",
        methods: ["GET"],
        isolation: "oauth-state-browser-binding"
      }
    ],
    controlPlaneSuccessResponses: {
      session: { type: "object" }
    }
  });
});

test("fails when a public TypeScript export is removed", async () => {
  const root = await createFixtureRepository();
  await writeSnapshot(root);
  await writeFile(
    join(root, "packages/control-plane/src/public.ts"),
    "export interface PublicType { readonly id: string }\n"
  );

  await assert.rejects(
    checkPublicApiSurface(root),
    /Public API surface drift.*@fixture\/control-plane.*publicValue/su
  );
});

test("fails when a REST method changes", async () => {
  const root = await createFixtureRepository();
  await writeSnapshot(root);
  await writeHttpContract(root, "POST");

  await assert.rejects(
    checkPublicApiSurface(root),
    /Public API surface drift.*\/v1\/session.*GET.*POST/su
  );
});

test("fails when a provider callback method changes", async () => {
  const root = await createFixtureRepository();
  await writeSnapshot(root);
  await writeCallbackContract(root, "POST");

  await assert.rejects(
    checkPublicApiSurface(root),
    /Public API surface drift.*provider-callbacks\/slack.*GET.*POST/su
  );
});

test("rejects a malformed snapshot with a stable error", async () => {
  const root = await createFixtureRepository();
  await writeFile(join(root, "api-surface.snapshot.json"), '{"version":2}\n');

  await assert.rejects(checkPublicApiSurface(root), {
    message: "Public API surface snapshot is invalid"
  });
});

test("rejects an unsupported package export map without exposing a local path", async () => {
  const root = await createFixtureRepository();
  await writeFile(
    join(root, "packages/control-plane/package.json"),
    JSON.stringify({
      name: "@fixture/control-plane",
      version: "1.0.0",
      type: "module",
      exports: { ".": { types: "./dist/index.js", import: "./dist/index.js" } }
    })
  );

  await assert.rejects(collectPublicApiSurface(root), {
    message: "Public package export map is unsupported"
  });
});

async function createFixtureRepository() {
  const root = await mkdtemp(join(tmpdir(), "tenantscript-api-surface-"));
  temporaryDirectories.push(root);
  await mkdir(join(root, "packages/control-plane/src"), { recursive: true });
  await mkdir(join(root, "docs/reference"), { recursive: true });
  await writeFile(
    join(root, "packages/control-plane/package.json"),
    JSON.stringify({
      name: "@fixture/control-plane",
      version: "1.0.0",
      type: "module",
      exports: {
        ".": { types: "./dist/index.d.ts", import: "./dist/index.js" }
      }
    })
  );
  await writeFile(
    join(root, "packages/control-plane/src/index.ts"),
    'export { publicValue, type PublicType } from "./public.js";\n'
  );
  await writeFile(
    join(root, "packages/control-plane/src/public.ts"),
    'export interface PublicType { readonly id: string }\nexport const publicValue = "stable";\n'
  );
  await writeHttpContract(root, "GET");
  await writeCallbackContract(root, "GET");
  await writeFile(
    join(root, "docs/reference/control-plane-success-responses.schema.json"),
    JSON.stringify({
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $defs: { session: { type: "object" } }
    })
  );
  return root;
}

async function writeCallbackContract(root, method) {
  await writeFile(
    join(root, "packages/control-plane/src/slack-oauth-callback-http.ts"),
    `export const PROVIDER_CALLBACK_HTTP_ENDPOINT_CONTRACTS = [\n  { id: "slackOAuthCallback", path: "/v1/provider-callbacks/slack", methods: ["${method}"], isolation: "oauth-state-browser-binding" }\n] as const;\n`
  );
}

async function writeHttpContract(root, method) {
  await writeFile(
    join(root, "packages/control-plane/src/http-api.ts"),
    `export const ADMIN_HTTP_ENDPOINT_CONTRACTS = [\n  { id: "session", path: "/v1/session", methods: ["${method}"], isolation: "identity", route: "session", success: { ${method}: { status: 200, body: "json", schema: "session" } } }\n] as const;\n`
  );
}

async function writeSnapshot(root) {
  const surface = await collectPublicApiSurface(root);
  await writeFile(
    join(root, "api-surface.snapshot.json"),
    await serializePublicApiSurface(surface)
  );
}
