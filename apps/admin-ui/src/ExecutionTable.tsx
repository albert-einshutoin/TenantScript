import { useEffect, useRef, useState, type UIEvent } from "react";
import type { DashboardSnapshot, ExecutionView } from "./api-client.js";
import { StatusPill } from "./StatusPill.js";

const ROW_HEIGHT = 52;
const VIEWPORT_HEIGHT = 520;
const OVERSCAN_ROWS = 5;

export function ExecutionTable({
  snapshot,
  executions = snapshot?.executions ?? [],
  resetKey,
  onView
}: {
  snapshot?: DashboardSnapshot;
  executions?: readonly ExecutionView[];
  resetKey?: number;
  onView?: (id: string) => void;
}) {
  const [requestedFirstVisibleIndex, setRequestedFirstVisibleIndex] = useState(0);
  const viewportRef = useRef<HTMLDivElement>(null);
  // A server-side search replaces the logical result set and must begin at row one. Cursor paging,
  // however, appends to the same set and should preserve the operator's position, so callers advance
  // this key only for replacements instead of resetting for every executions-array identity change.
  useEffect(() => {
    setRequestedFirstVisibleIndex(0);
    if (viewportRef.current !== null) viewportRef.current.scrollTop = 0;
  }, [resetKey]);
  // Loaded cursor pages can grow without bound during an operator session. Deriving a small
  // viewport window keeps DOM and reconciliation cost bounded while retaining every row in memory
  // for filtering, paging, and stable detail lookup. Storing the row index instead of raw pixels
  // also avoids a React update for every scroll event that stays within the same fixed-height row.
  const firstVisibleIndex = Math.min(
    requestedFirstVisibleIndex,
    Math.max(0, executions.length - 1)
  );
  const startIndex = Math.max(0, firstVisibleIndex - OVERSCAN_ROWS);
  const endIndex = Math.min(
    executions.length,
    firstVisibleIndex + Math.ceil(VIEWPORT_HEIGHT / ROW_HEIGHT) + OVERSCAN_ROWS
  );
  const visibleExecutions = executions.slice(startIndex, endIndex);
  const columnCount = onView === undefined ? 6 : 7;
  const topSpacerHeight = startIndex * ROW_HEIGHT;
  const bottomSpacerHeight = (executions.length - endIndex) * ROW_HEIGHT;

  return (
    <div
      ref={viewportRef}
      className="table-wrap execution-table-viewport"
      role="region"
      aria-label="Execution results"
      tabIndex={0}
      onScroll={(event: UIEvent<HTMLDivElement>) => {
        setRequestedFirstVisibleIndex(Math.floor(event.currentTarget.scrollTop / ROW_HEIGHT));
      }}
    >
      <table aria-rowcount={executions.length + 1}>
        <thead>
          <tr>
            <th>Execution ID</th>
            <th>Hook</th>
            <th>Plugin</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Capabilities</th>
            {onView === undefined ? null : <th>Details</th>}
          </tr>
        </thead>
        <tbody>
          {topSpacerHeight === 0 ? null : (
            <tr aria-hidden="true" className="virtual-spacer-row">
              <td colSpan={columnCount} style={{ height: topSpacerHeight }} />
            </tr>
          )}
          {visibleExecutions.map((execution, offset) => (
            <tr
              key={execution.id}
              aria-rowindex={startIndex + offset + 2}
              className="virtual-execution-row"
            >
              <td>{execution.id}</td>
              <td>{execution.hookName}</td>
              <td>{execution.pluginId}</td>
              <td>
                <StatusPill status={execution.status} />
              </td>
              <td>{execution.durationMs}ms</td>
              <td>
                {execution.capabilityNames.length === 0
                  ? "none"
                  : execution.capabilityNames.join(", ")}
              </td>
              {onView === undefined ? null : (
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      onView(execution.id);
                    }}
                  >
                    View {execution.id}
                  </button>
                </td>
              )}
            </tr>
          ))}
          {bottomSpacerHeight === 0 ? null : (
            <tr aria-hidden="true" className="virtual-spacer-row">
              <td colSpan={columnCount} style={{ height: bottomSpacerHeight }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
