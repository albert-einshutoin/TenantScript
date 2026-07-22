const FAILED = Object.freeze({ manifest: false, "least-privilege": false });

export function evaluatePluginAuthoringManifestJudges({ task, manifest, parseManifest }) {
  if (typeof parseManifest !== "function") return { ...FAILED };

  let parsedManifest;
  try {
    // The parser receives a detached value so a hostile or faulty implementation cannot mutate
    // the caller-owned candidate evidence or influence a later judge through shared state.
    const result = parseManifest(structuredClone(manifest));
    if (!isPlainRecord(result) || !hasExactKeys(result, ["ok", "value"]) || result.ok !== true) {
      return { ...FAILED };
    }
    parsedManifest = structuredClone(result.value);
    if (!isPlainRecord(parsedManifest)) return { ...FAILED };
  } catch {
    // Parser diagnostics can contain source fragments and secrets. This policy boundary exposes
    // only booleans that the orchestration core maps to its fixed failure taxonomy.
    return { ...FAILED };
  }

  return {
    manifest: true,
    "least-privilege": matchesLeastPrivilegeContract(task, parsedManifest)
  };
}

function matchesLeastPrivilegeContract(task, manifest) {
  try {
    if (!isPlainRecord(task) || !isPlainRecord(task.hook) || !isPlainRecord(task.egress)) {
      return false;
    }
    if (!Array.isArray(task.capabilities) || !Array.isArray(manifest.hooks)) return false;
    if (manifest.hooks.length !== 1 || !isPlainRecord(manifest.hooks[0])) return false;
    const [hook] = manifest.hooks;
    if (hook.name !== task.hook.name || hook.type !== task.hook.type) return false;
    if (!isPlainRecord(manifest.capabilities) || !isPlainRecord(manifest.egress)) return false;

    const expectedCapabilities = [...task.capabilities].sort(compareText);
    const observedCapabilities = Object.keys(manifest.capabilities).sort(compareText);
    return (
      arrayEquals(observedCapabilities, expectedCapabilities) &&
      task.egress.mode === "deny" &&
      manifest.egress.mode === task.egress.mode
    );
  } catch {
    return false;
  }
}

function isPlainRecord(value) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, expected) {
  return arrayEquals(Object.keys(value).sort(compareText), [...expected].sort(compareText));
}

function arrayEquals(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}
