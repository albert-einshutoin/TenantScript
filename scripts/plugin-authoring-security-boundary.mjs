export async function runAfterPluginAuthoringBoundaryProbes({
  runBoundaryProbes,
  dispatchCandidate
}) {
  if (typeof runBoundaryProbes !== "function" || typeof dispatchCandidate !== "function") {
    throw new Error("plugin authoring security boundary failed");
  }
  // A failed probe means the authority boundary is already known to be broken. Never hand unknown
  // candidate code to that runtime merely to produce a richer failure observation.
  if ((await runBoundaryProbes()) !== true) {
    throw new Error("plugin authoring security boundary failed");
  }
  return await dispatchCandidate();
}
