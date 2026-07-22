import assert from "node:assert/strict";
import test from "node:test";

import { runAfterPluginAuthoringBoundaryProbes } from "./plugin-authoring-security-boundary.mjs";

test("does not dispatch candidate code after a failed loader boundary probe", async () => {
  let dispatches = 0;
  await assert.rejects(
    () =>
      runAfterPluginAuthoringBoundaryProbes({
        runBoundaryProbes: async () => false,
        dispatchCandidate: async () => {
          dispatches += 1;
          return { unsafe: true };
        }
      }),
    { message: "plugin authoring security boundary failed" }
  );
  assert.equal(dispatches, 0);
});

test("dispatches exactly once only after every boundary probe passes", async () => {
  let dispatches = 0;
  const result = await runAfterPluginAuthoringBoundaryProbes({
    runBoundaryProbes: async () => true,
    dispatchCandidate: async () => {
      dispatches += 1;
      return { safe: true };
    }
  });
  assert.deepEqual(result, { safe: true });
  assert.equal(dispatches, 1);
});
