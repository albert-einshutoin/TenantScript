import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "../../../src/App.js";
import {
  AdminApiError,
  createDemoAdminApiClient,
  type AdminApiClient,
  type DashboardSnapshot
} from "../../../src/api-client.js";
import "../../../src/styles.css";

type VisualScenario = "default" | "empty" | "loading" | "error" | "large-dataset";

const scenario = visualScenario(new URLSearchParams(window.location.search).get("scenario"));
document.documentElement.dataset.visualScenario = scenario;

const root = document.getElementById("root");
if (root === null) throw new Error("visual fixture root is missing");

createRoot(root).render(
  <StrictMode>
    <App client={createVisualClient(scenario)} />
  </StrictMode>
);

function createVisualClient(scenario: VisualScenario): AdminApiClient {
  const base = createDemoAdminApiClient();
  switch (scenario) {
    case "default":
      return base;
    case "loading":
      return { ...base, getDashboard: () => new Promise<DashboardSnapshot>(() => {}) };
    case "error":
      return {
        ...base,
        getDashboard: () =>
          Promise.reject(new AdminApiError(503, "visual_fixture_unavailable", "synthetic failure"))
      };
    case "empty":
      return {
        ...base,
        getDashboard: async (session) => emptySnapshot(await base.getDashboard(session)),
        getAuditEvents: () => Promise.resolve({ section: "auditEvents", items: [] }),
        getProviderConnections: () => Promise.resolve([])
      };
    case "large-dataset":
      return {
        ...base,
        getDashboard: async (session) => largeSnapshot(await base.getDashboard(session))
      };
  }
}

function emptySnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  return {
    ...snapshot,
    installations: [],
    pluginVersions: [],
    approvals: [],
    executions: [],
    auditEvents: [],
    providerConnections: [],
    schemaMigrations: [],
    cursors: {}
  };
}

function largeSnapshot(snapshot: DashboardSnapshot): DashboardSnapshot {
  const source = snapshot.installations[0];
  if (source === undefined) throw new Error("visual fixture installation is missing");
  return {
    ...snapshot,
    installations: Array.from({ length: 36 }, (_, index) => ({
      ...source,
      id: `inst_visual_${String(index).padStart(2, "0")}`,
      pluginKey: `visual-plugin-${String(index).padStart(2, "0")}-with-bounded-synthetic-name`,
      priority: index + 1,
      revision: index
    }))
  };
}

function visualScenario(value: string | null): VisualScenario {
  switch (value) {
    case "empty":
    case "loading":
    case "error":
    case "large-dataset":
      return value;
    default:
      return "default";
  }
}
