import assert from "node:assert/strict";
import { test } from "node:test";
import { validateBreakingReleasePolicy } from "./release-policy.mjs";

test("rejects a removed public export without a major changeset", () => {
  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface: surface({ exports: [symbol("PublicType", "type"), symbol("publicValue")] }),
        currentSurface: surface({ exports: [symbol("PublicType", "type")] }),
        changesets: [],
        repositoryFiles: new Set()
      }),
    /@tenantscript\/capabilities.*removed export publicValue.*major Changeset is required/su
  );
});

test("rejects an export kind change covered by only a minor changeset", () => {
  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface: surface({ exports: [symbol("createCapability", "type+value")] }),
        currentSurface: surface({ exports: [symbol("createCapability", "value")] }),
        changesets: [
          changeset(
            "capability-kind.md",
            "minor",
            "[Migration guide](../docs/migrations/capability-kind.md)"
          )
        ],
        repositoryFiles: new Set(["docs/migrations/capability-kind.md"])
      }),
    /changed export createCapability.*major Changeset is required/su
  );
});

test("rejects a REST contract change without a repository migration guide", () => {
  const baseSurface = surface({
    rest: [{ id: "session", path: "/v1/session", methods: ["GET"], isolation: "identity" }]
  });
  const currentSurface = surface({
    rest: [{ id: "session", path: "/v2/session", methods: ["POST"], isolation: "tenant" }]
  });

  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface,
        currentSurface,
        changesets: [changeset("session-v2.md", "major", "No migration link")],
        repositoryFiles: new Set()
      }),
    /@tenantscript\/control-plane.*migration guide.*docs\/migrations/su
  );
});

test("accepts breaking changes with an affected-package major changeset and migration guide", () => {
  assert.doesNotThrow(() =>
    validateBreakingReleasePolicy({
      baseSurface: surface({ exports: [symbol("PublicType", "type"), symbol("publicValue")] }),
      currentSurface: surface({ exports: [symbol("PublicType", "type")] }),
      changesets: [
        changeset(
          "remove-public-value.md",
          "major",
          "[Migration guide](../docs/migrations/remove-public-value.md)"
        )
      ],
      repositoryFiles: new Set(["docs/migrations/remove-public-value.md"])
    })
  );
});

test("does not require a changeset for additive public API changes", () => {
  assert.doesNotThrow(() =>
    validateBreakingReleasePolicy({
      baseSurface: surface({ exports: [symbol("PublicType", "type")] }),
      currentSurface: surface({
        exports: [symbol("PublicType", "type"), symbol("publicValue")],
        rest: [{ id: "session", path: "/v1/session", methods: ["GET"], isolation: "identity" }]
      }),
      changesets: [],
      repositoryFiles: new Set()
    })
  );
});

test("rejects a changed REST success status or body schema without a major changeset", () => {
  const success = [{ method: "GET", status: 200, body: "json", schema: "session" }];
  const baseSurface = surface({
    rest: [
      { id: "session", path: "/v1/session", methods: ["GET"], isolation: "identity", success }
    ],
    successSchemas: { session: { type: "object", required: ["subject"] } }
  });
  const currentSurface = surface({
    rest: [
      {
        id: "session",
        path: "/v1/session",
        methods: ["GET"],
        isolation: "identity",
        success: [{ ...success[0], status: 201 }]
      }
    ],
    successSchemas: { session: { type: "object", required: [] } }
  });

  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface,
        currentSurface,
        changesets: [],
        repositoryFiles: new Set()
      }),
    /changed REST success response session GET.*changed REST success schema session.*major Changeset/su
  );
});

test("rejects a changed provider callback contract without a major changeset", () => {
  const callback = {
    id: "slackOAuthCallback",
    path: "/v1/provider-callbacks/slack",
    methods: ["GET"],
    isolation: "oauth-state-browser-binding"
  };

  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface: surface({ callbacks: [callback] }),
        currentSurface: surface({
          callbacks: [{ ...callback, methods: ["POST"], isolation: "none" }]
        }),
        changesets: [],
        repositoryFiles: new Set()
      }),
    /@tenantscript\/control-plane.*changed callback contract slackOAuthCallback.*removed callback methods GET from slackOAuthCallback.*major Changeset/su
  );
  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface: surface({ callbacks: [callback] }),
        currentSurface: surface(),
        changesets: [],
        repositoryFiles: new Set()
      }),
    /@tenantscript\/control-plane.*removed callback slackOAuthCallback.*major Changeset/su
  );
});

test("rejects unknown packages in a breaking-change changeset", () => {
  assert.throws(
    () =>
      validateBreakingReleasePolicy({
        baseSurface: surface({ exports: [symbol("publicValue")] }),
        currentSurface: surface({ exports: [] }),
        changesets: [
          {
            path: ".changeset/unknown.md",
            content:
              '---\n"@tenantscript/unknown": major\n---\n\n[Migration guide](../docs/migrations/unknown.md)\n'
          }
        ],
        repositoryFiles: new Set(["docs/migrations/unknown.md"])
      }),
    /unknown public package @tenantscript\/unknown/u
  );
});

function changeset(name, bump, body) {
  return {
    path: `.changeset/${name}`,
    content: `---\n"@tenantscript/capabilities": ${bump}\n"@tenantscript/control-plane": ${bump}\n---\n\n${body}\n`
  };
}

function surface({ exports = [], rest = [], callbacks = [], successSchemas } = {}) {
  return {
    version: 1,
    packages: [
      {
        name: "@tenantscript/capabilities",
        subpaths: [{ subpath: ".", exports }]
      },
      {
        name: "@tenantscript/control-plane",
        subpaths: [{ subpath: ".", exports: [] }]
      }
    ],
    controlPlaneRest: rest,
    controlPlaneCallbacks: callbacks,
    ...(successSchemas === undefined ? {} : { controlPlaneSuccessResponses: successSchemas })
  };
}

function symbol(name, kind = "value") {
  return { name, kind };
}
