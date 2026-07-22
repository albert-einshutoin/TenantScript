export const PLUGIN_AUTHORING_JUDGE_ENTRYPOINT = "/opt/tenantscript/bin/plugin-authoring-judge";

export const PLUGIN_AUTHORING_JUDGE_PATHS = Object.freeze({
  requestPath: "/input/request.json",
  baselineRoot: "/baseline",
  candidateRoot: "/candidate",
  workspaceRoot: "/work"
});

export const PLUGIN_AUTHORING_JUDGE_ARGV = Object.freeze([
  `--request=${PLUGIN_AUTHORING_JUDGE_PATHS.requestPath}`,
  `--baseline=${PLUGIN_AUTHORING_JUDGE_PATHS.baselineRoot}`,
  `--candidate=${PLUGIN_AUTHORING_JUDGE_PATHS.candidateRoot}`,
  `--workspace=${PLUGIN_AUTHORING_JUDGE_PATHS.workspaceRoot}`
]);
