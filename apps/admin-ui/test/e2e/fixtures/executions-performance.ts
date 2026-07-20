import { createElement, Fragment, useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { ExecutionTable } from "../../../src/ExecutionTable.js";
import type { ExecutionView } from "../../../src/api-client.js";
import "../../../src/styles.css";

const EXECUTION_COUNT = 100_000;
const startedAt = performance.now();
const createdAt = new Date("2026-07-21T00:00:00.000Z");
const capabilityNames = ["slack.send"] as const;
const executions: readonly ExecutionView[] = Array.from(
  { length: EXECUTION_COUNT },
  (_, index) => ({
    id: `exec_perf_${String(index).padStart(6, "0")}`,
    pluginId: "plugin_performance_fixture",
    hookName: "fixture.executed",
    version: "1.0.0",
    status: index % 10 === 0 ? "error" : "success",
    durationMs: index % 97,
    capabilityNames,
    createdAt
  })
);

function PerformanceFixture() {
  const [openedExecution, setOpenedExecution] = useState<string | null>(null);

  useEffect(() => {
    requestAnimationFrame(() => {
      globalThis.__executionPerformance = {
        executionCount: executions.length,
        initialRenderMs: performance.now() - startedAt
      };
      document.documentElement.dataset.performanceReady = "true";
    });
  }, []);

  return createElement(
    Fragment,
    null,
    createElement(ExecutionTable, { executions, onView: setOpenedExecution }),
    createElement(
      "p",
      { role: "status" },
      openedExecution === null ? "No execution opened" : `Opened ${openedExecution}`
    )
  );
}

declare global {
  var __executionPerformance: { executionCount: number; initialRenderMs: number } | undefined;
}

const root = document.getElementById("root");
if (root === null) throw new Error("performance fixture root is missing");
createRoot(root).render(createElement(PerformanceFixture));
