import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode
} from "react";
import {
  createUnavailableAdminApiClient,
  AdminApiError,
  type AdminApiClient,
  type AdminSession,
  type ApprovalDecisionRequest,
  type ApprovalDecisionResult,
  type ApprovalView,
  type DashboardSectionPage,
  type DashboardSnapshot,
  type ExecutionDetailView,
  type ExecutionSearchRequest,
  type ExecutionView,
  type InstallPluginRequest,
  type InstallPluginResult,
  type InstallPreview,
  type InstallRequestResult,
  type InstallationCommandRequest,
  type InstallationPermissionReview,
  type RollbackInstallationRequest,
  type RollbackInstallationResult
} from "./api-client.js";
import type { AdminDashboardSection } from "@tenantscript/control-plane";
import { canRolePerform } from "@tenantscript/control-plane/rbac";
import { ExecutionTable } from "./ExecutionTable.js";
import { type AdminRoute, useHashRoute } from "./router.js";
import { StatusPill } from "./StatusPill.js";

const defaultClient = createUnavailableAdminApiClient();

export function App({ client = defaultClient }: { client?: AdminApiClient }) {
  const [session, setSession] = useState<AdminSession | null>(null);
  const skipToMainContent = useCallback((event: MouseEvent<HTMLAnchorElement>) => {
    // Admin routes also use the URL fragment. Preventing native hash replacement preserves the
    // current workspace while retaining link semantics for keyboard and assistive-technology users.
    event.preventDefault();
    document.getElementById("main-content")?.focus();
  }, []);

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content" onClick={skipToMainContent}>
        Skip to main content
      </a>
      {session === null ? (
        <main id="main-content" tabIndex={-1}>
          <LoginPanel client={client} onLogin={setSession} />
        </main>
      ) : (
        <AdminShell
          client={client}
          session={session}
          onLogout={() => {
            client.clearSession();
            setSession(null);
          }}
        />
      )}
    </div>
  );
}

function LoginPanel({
  client,
  onLogin
}: {
  client: AdminApiClient;
  onLogin: (session: AdminSession) => void;
}) {
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = useCallback(() => {
    setSubmitting(true);
    setError(null);
    void client
      .resolveSession({ token })
      .then(onLogin)
      .catch((cause: unknown) => {
        setError(cause instanceof AdminApiError ? cause.message : "Token rejected");
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [client, onLogin, token]);

  return (
    <section className="login-layout" aria-labelledby="login-title">
      <div className="login-panel">
        <p className="eyebrow">TenantScript</p>
        <h1 id="login-title">Admin Console</h1>
        <form
          className="login-form"
          onSubmit={(event) => {
            event.preventDefault();
            submit();
          }}
        >
          <label htmlFor="token">Token</label>
          <input
            id="token"
            name="token"
            type="password"
            autoComplete="off"
            autoCapitalize="none"
            spellCheck={false}
            value={token}
            onChange={(event) => {
              setToken(event.currentTarget.value);
            }}
          />
          {error === null ? null : <p className="form-error">{error}</p>}
          <button type="submit" disabled={submitting}>
            {submitting ? "Signing in" : "Sign in"}
          </button>
        </form>
      </div>
    </section>
  );
}

function AdminShell({
  client,
  session,
  onLogout
}: {
  client: AdminApiClient;
  session: AdminSession;
  onLogout: () => void;
}) {
  const [route, setRoute] = useHashRoute();
  const [snapshot, setSnapshot] = useState<DashboardSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loadingSection, setLoadingSection] = useState<AdminDashboardSection | null>(null);
  const [permissionReview, setPermissionReview] = useState<InstallationPermissionReview | null>(
    null
  );
  const [permissionLoading, setPermissionLoading] = useState(false);
  const [permissionError, setPermissionError] = useState<string | null>(null);
  const [commandInFlight, setCommandInFlight] = useState(false);
  const [installPreview, setInstallPreview] = useState<InstallPreview | null>(null);
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installInFlight, setInstallInFlight] = useState(false);
  const [rollbackInFlight, setRollbackInFlight] = useState(false);
  const permissionRequest = useRef(0);
  const installPreviewRequest = useRef(0);

  useEffect(() => {
    let active = true;
    void Promise.all([
      client.getDashboard(session),
      client.getAuditEvents(),
      client.getOperationalHealth(),
      client.getProviderConnections()
    ])
      .then(([nextSnapshot, auditPage, operationalHealth, providerConnections]) => {
        if (active) {
          setSnapshot({
            ...nextSnapshot,
            auditEvents: auditPage.items,
            operationalHealth,
            providerConnections,
            cursors: {
              ...nextSnapshot.cursors,
              ...(auditPage.nextCursor === undefined ? {} : { auditEvents: auditPage.nextCursor })
            }
          });
        }
      })
      .catch(() => {
        if (active) {
          setError("Dashboard unavailable");
        }
      });
    return () => {
      active = false;
    };
  }, [client, session]);

  const refreshDashboard = useCallback(async () => {
    const [refreshed, operationalHealth] = await Promise.all([
      client.getDashboard(session),
      client.getOperationalHealth()
    ]);
    // Audit pagination and the read-only connection inventory are independent from mutation
    // refreshes. Operational health, however, must move with usage so Overview never combines a
    // current execution count with stale failures.
    setSnapshot((current) => preserveAuditSlice(current, { ...refreshed, operationalHealth }));
  }, [client, session]);

  const loadMore = useCallback(
    (section: AdminDashboardSection) => {
      const cursor = snapshot?.cursors[section];
      if (cursor === undefined || loadingSection !== null) {
        return;
      }
      setLoadingSection(section);
      setError(null);
      void client
        .getDashboardSection(section, cursor)
        .then((page) => {
          setSnapshot((current) => (current === null ? current : appendPage(current, page)));
        })
        .catch(() => {
          setError("Could not load more dashboard results");
        })
        .finally(() => {
          setLoadingSection(null);
        });
    },
    [client, loadingSection, snapshot]
  );

  const openPermissionReview = useCallback(
    (id: string) => {
      const requestId = permissionRequest.current + 1;
      permissionRequest.current = requestId;
      setPermissionLoading(true);
      setPermissionError(null);
      setPermissionReview(null);
      void client
        .getInstallationPermissionReview(id)
        .then((review) => {
          if (permissionRequest.current === requestId) {
            setPermissionReview(review);
          }
        })
        .catch(() => {
          if (permissionRequest.current === requestId) {
            setPermissionError("Permission review unavailable");
          }
        })
        .finally(() => {
          if (permissionRequest.current === requestId) {
            setPermissionLoading(false);
          }
        });
    },
    [client]
  );

  const updateInstallation = useCallback(
    async (request: InstallationCommandRequest) => {
      setCommandInFlight(true);
      try {
        const updated = await client.updateInstallationCommand(request);
        // Installation controls change only after the server accepts the command. This avoids
        // showing an authorization or audit failure as a successful local state transition.
        setSnapshot((current) =>
          current === null
            ? current
            : {
                ...current,
                installations: current.installations.map((installation) =>
                  installation.id === updated.id
                    ? {
                        ...installation,
                        enabled: updated.enabled,
                        priority: updated.priority,
                        revision: updated.revision,
                        statusText: updated.enabled ? "enabled" : "disabled"
                      }
                    : installation
                )
              }
        );
        return updated;
      } catch (commandError) {
        if (
          commandError instanceof AdminApiError &&
          commandError.status === 409 &&
          commandError.code === "installation_revision_conflict"
        ) {
          // A conflict means every local installation revision may be stale. Refresh the complete
          // tenant snapshot before allowing another command so retries cannot loop on the old CAS.
          await refreshDashboard();
        }
        throw commandError;
      } finally {
        setCommandInFlight(false);
      }
    },
    [client, refreshDashboard]
  );

  const openInstallPreview = useCallback(
    (versionId: string) => {
      const requestId = installPreviewRequest.current + 1;
      installPreviewRequest.current = requestId;
      setInstallLoading(true);
      setInstallError(null);
      setInstallPreview(null);
      void client
        .getInstallPreview(versionId)
        .then((preview) => {
          if (installPreviewRequest.current === requestId) setInstallPreview(preview);
        })
        .catch(() => {
          if (installPreviewRequest.current === requestId) {
            setInstallError("Installation preview unavailable");
          }
        })
        .finally(() => {
          if (installPreviewRequest.current === requestId) setInstallLoading(false);
        });
    },
    [client]
  );

  const installPlugin = useCallback(
    async (request: InstallPluginRequest) => {
      setInstallInFlight(true);
      setInstallError(null);
      try {
        const installed = await client.installPlugin(request);
        // Install results are not applied optimistically: refreshing also reconciles pagination,
        // server defaults, and any concurrent installation changes in the tenant.
        await refreshDashboard();
        setInstallPreview(null);
        return installed;
      } catch (cause) {
        setInstallError(
          cause instanceof AdminApiError && cause.code === "invalid_config"
            ? "Configuration does not satisfy the plugin schema"
            : "Plugin installation unavailable"
        );
        throw cause;
      } finally {
        setInstallInFlight(false);
      }
    },
    [client, refreshDashboard]
  );

  const requestInstallation = useCallback(
    async (request: InstallPluginRequest) => {
      setInstallInFlight(true);
      setInstallError(null);
      try {
        const result = await client.requestInstallation(request);
        // Refresh only after the server returns the approval id. This keeps the queue and the
        // operator's success evidence correlated with the exact normalized grant proposal.
        void refreshDashboard().catch(() => {
          // The mutation has already succeeded. Preserve its approval id and report only the
          // secondary refresh failure so a user does not submit a different request by mistake.
          setError("Approval request created; dashboard refresh unavailable");
        });
        return result;
      } catch (cause) {
        setInstallError(
          cause instanceof AdminApiError && cause.code === "invalid_config"
            ? "Configuration does not satisfy the plugin schema"
            : "Installation approval request unavailable"
        );
        throw cause;
      } finally {
        setInstallInFlight(false);
      }
    },
    [client, refreshDashboard]
  );

  const rollbackInstallation = useCallback(
    async (request: RollbackInstallationRequest) => {
      setRollbackInFlight(true);
      try {
        const result = await client.rollbackInstallation(request);
        // A fresh snapshot is the completion signal: it proves the current pin changed on the
        // server and avoids presenting a local optimistic version as an operational rollback.
        await refreshDashboard();
        return result;
      } catch (cause) {
        if (
          cause instanceof AdminApiError &&
          cause.status === 409 &&
          cause.code === "installation_revision_conflict"
        ) {
          await refreshDashboard();
        }
        throw cause;
      } finally {
        setRollbackInFlight(false);
      }
    },
    [client, refreshDashboard]
  );

  const decideApproval = useCallback(
    async (request: ApprovalDecisionRequest) => {
      const result = await client.decideApproval(request);
      if (result.installation !== undefined) {
        // Grant approval creates the installation in the same server transaction. Reloading the
        // tenant snapshot makes that atomic completion visible instead of leaving a stale queue.
        void refreshDashboard().catch(() => {
          setError("Approval completed; dashboard refresh unavailable");
        });
        return result;
      }
      // Apply the queue transition only after correlated audit evidence is returned.
      setSnapshot((current) =>
        current === null
          ? current
          : {
              ...current,
              approvals: current.approvals.map((approval) =>
                approval.id === result.approvalId ? { ...approval, state: result.state } : approval
              )
            }
      );
      return result;
    },
    [client, refreshDashboard]
  );

  return (
    <section className="admin-layout">
      <aside className="sidebar" aria-label="TenantScript Admin navigation">
        <div className="brand-lockup">
          <span className="brand-mark">TS</span>
          <div>
            <p>TenantScript</p>
            <span>Control Plane</span>
          </div>
        </div>
        <nav className="nav-list">
          {routeItems.map((item) => (
            <button
              key={item.route}
              type="button"
              className={route === item.route ? "active" : ""}
              onClick={() => {
                setRoute(item.route);
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <main id="main-content" className="workspace" tabIndex={-1}>
        <header className="topbar">
          <div>
            <p className="eyebrow">Acme Production</p>
            <h1>{titleForRoute(route)}</h1>
          </div>
          <div className="session-chip" aria-label={`signed in as ${session.role}`}>
            <span>{session.subject}</span>
            <strong>{session.role}</strong>
          </div>
          <div
            className={`telemetry-chip ${snapshot?.telemetry.enabled === true ? "enabled" : "disabled"}`}
            aria-label="Anonymous telemetry setting"
          >
            <span>Anonymous telemetry</span>
            <strong>{snapshot?.telemetry.enabled === true ? "On" : "Off"}</strong>
          </div>
          <button type="button" className="secondary-button" onClick={onLogout}>
            Sign out
          </button>
        </header>
        {error === null ? null : <p className="form-error">{error}</p>}
        {snapshot === null ? (
          <div className="loading-panel">Loading</div>
        ) : (
          <RoutePanel
            route={route}
            session={session}
            snapshot={snapshot}
            loadingSection={loadingSection}
            onLoadMore={loadMore}
            permissionReview={permissionReview}
            permissionLoading={permissionLoading}
            permissionError={permissionError}
            onPermissionReview={openPermissionReview}
            onInstallationCommand={updateInstallation}
            commandInFlight={commandInFlight}
            installPreview={installPreview}
            installLoading={installLoading}
            installError={installError}
            onInstallPreview={openInstallPreview}
            onInstall={installPlugin}
            onInstallRequest={requestInstallation}
            installInFlight={installInFlight}
            onRollback={rollbackInstallation}
            rollbackInFlight={rollbackInFlight}
            onViewExecutions={() => {
              setRoute("executions");
            }}
            onSearchExecutions={client.searchExecutions}
            onExecutionDetail={client.getExecutionDetail}
            onApprovalDecision={decideApproval}
          />
        )}
      </main>
    </section>
  );
}

const routeItems: readonly { route: AdminRoute; label: string }[] = [
  { route: "overview", label: "Overview" },
  { route: "installations", label: "Installations" },
  { route: "versions", label: "Versions" },
  { route: "approvals", label: "Approval queue" },
  { route: "executions", label: "Executions" },
  { route: "connections", label: "Connections" },
  { route: "audit", label: "Audit log" }
];

function RoutePanel({
  route,
  session,
  snapshot,
  loadingSection,
  onLoadMore,
  permissionReview,
  permissionLoading,
  permissionError,
  onPermissionReview,
  onInstallationCommand,
  commandInFlight,
  installPreview,
  installLoading,
  installError,
  onInstallPreview,
  onInstall,
  onInstallRequest,
  installInFlight,
  onRollback,
  rollbackInFlight,
  onViewExecutions,
  onSearchExecutions,
  onExecutionDetail,
  onApprovalDecision
}: {
  route: AdminRoute;
  session: AdminSession;
  snapshot: DashboardSnapshot;
  loadingSection: AdminDashboardSection | null;
  onLoadMore: (section: AdminDashboardSection) => void;
  permissionReview: InstallationPermissionReview | null;
  permissionLoading: boolean;
  permissionError: string | null;
  onPermissionReview: (id: string) => void;
  onInstallationCommand: (request: InstallationCommandRequest) => Promise<unknown>;
  commandInFlight: boolean;
  installPreview: InstallPreview | null;
  installLoading: boolean;
  installError: string | null;
  onInstallPreview: (versionId: string) => void;
  onInstall: (request: InstallPluginRequest) => Promise<InstallPluginResult>;
  onInstallRequest: (request: InstallPluginRequest) => Promise<InstallRequestResult>;
  installInFlight: boolean;
  onRollback: (request: RollbackInstallationRequest) => Promise<RollbackInstallationResult>;
  rollbackInFlight: boolean;
  onViewExecutions: () => void;
  onSearchExecutions: AdminApiClient["searchExecutions"];
  onExecutionDetail: AdminApiClient["getExecutionDetail"];
  onApprovalDecision: (request: ApprovalDecisionRequest) => Promise<ApprovalDecisionResult>;
}) {
  switch (route) {
    case "overview":
      return <OverviewPanel snapshot={snapshot} />;
    case "installations":
      return (
        <InstallationsPanel
          snapshot={snapshot}
          loading={loadingSection === "installations"}
          onLoadMore={() => {
            onLoadMore("installations");
          }}
          permissionReview={permissionReview}
          permissionLoading={permissionLoading}
          permissionError={permissionError}
          onPermissionReview={onPermissionReview}
          canManage={canRolePerform(session.role, "installation:manage")}
          onInstallationCommand={onInstallationCommand}
          commandInFlight={commandInFlight}
        />
      );
    case "versions":
      return (
        <VersionsPanel
          snapshot={snapshot}
          canRequest={canRolePerform(session.role, "installation:request")}
          canInstall={canRolePerform(session.role, "installation:manage")}
          loading={loadingSection === "pluginVersions"}
          onLoadMore={() => {
            onLoadMore("pluginVersions");
          }}
          installPreview={installPreview}
          installLoading={installLoading}
          installError={installError}
          onInstallPreview={onInstallPreview}
          onInstall={onInstall}
          onInstallRequest={onInstallRequest}
          installInFlight={installInFlight}
          tenantId={session.tenantId}
          onRollback={onRollback}
          rollbackInFlight={rollbackInFlight}
          onViewExecutions={onViewExecutions}
        />
      );
    case "approvals":
      return (
        <ApprovalsPanel
          snapshot={snapshot}
          tenantId={session.tenantId}
          canDecide={canRolePerform(session.role, "approval:decide")}
          loading={loadingSection === "approvals"}
          onLoadMore={() => {
            onLoadMore("approvals");
          }}
          onDecision={onApprovalDecision}
        />
      );
    case "executions":
      return (
        <ExecutionsPanel
          snapshot={snapshot}
          tenantId={session.tenantId}
          loading={loadingSection === "executions"}
          onLoadMore={() => {
            onLoadMore("executions");
          }}
          onSearch={onSearchExecutions}
          onDetail={onExecutionDetail}
        />
      );
    case "audit":
      return (
        <AuditPanel
          snapshot={snapshot}
          loading={loadingSection === "auditEvents"}
          onLoadMore={() => {
            onLoadMore("auditEvents");
          }}
        />
      );
    case "connections":
      return <ConnectionsPanel snapshot={snapshot} />;
  }
}

function ConnectionsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <section className="data-panel" aria-label="Provider connections">
      <PanelHeader title="Provider connections" detail="Secret-safe metadata" />
      {snapshot.providerConnections.length === 0 ? (
        <p className="empty-state">No provider connections yet</p>
      ) : (
        <TableViewport label="Provider connection table">
          <table>
            <thead>
              <tr>
                <th>Provider</th>
                <th>Workspace</th>
                <th>Workspace ID</th>
                <th>Bot user</th>
                <th>Connected</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.providerConnections.map((connection) => (
                <tr key={connection.id}>
                  <td>{connection.provider}</td>
                  <td>{connection.workspaceName ?? "Unnamed workspace"}</td>
                  <td>{connection.workspaceId}</td>
                  <td>{connection.botUserId ?? "Not reported"}</td>
                  <td>{connection.connectedAt.toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
    </section>
  );
}

function AuditPanel({
  snapshot,
  loading,
  onLoadMore
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section className="data-panel" aria-label="Tenant audit log">
      <PanelHeader title="Audit events" detail="Newest first" />
      {snapshot.auditEvents.length === 0 ? (
        <p className="empty-state">No audit events yet</p>
      ) : (
        <TableViewport label="Tenant audit event table">
          <table>
            <thead>
              <tr>
                <th>Time</th>
                <th>Actor</th>
                <th>Action</th>
                <th>Installation</th>
                <th>Plugin</th>
                <th>Revision</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {snapshot.auditEvents.map((event) => (
                <tr key={event.id}>
                  <td>{event.createdAt.toLocaleString()}</td>
                  <td>{event.actor}</td>
                  <td>{event.action}</td>
                  <td>{event.installationId}</td>
                  <td>{event.pluginId}</td>
                  <td>{event.revision}</td>
                  <td>{auditChangeSummary(event.before, event.after)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </TableViewport>
      )}
      <LoadMoreButton
        section="audit events"
        cursor={snapshot.cursors.auditEvents}
        loading={loading}
        onClick={onLoadMore}
      />
    </section>
  );
}

function auditChangeSummary(
  before: DashboardSnapshot["auditEvents"][number]["before"],
  after: DashboardSnapshot["auditEvents"][number]["after"]
): string {
  const changes: string[] = [];
  for (const key of ["enabled", "priority", "revision", "version"] as const) {
    if (before[key] !== after[key]) {
      changes.push(`${key}: ${auditStateValue(before[key])} → ${auditStateValue(after[key])}`);
    }
  }
  return changes.length === 0 ? "No public state change" : changes.join(", ");
}

function auditStateValue(value: boolean | number | string | undefined): string {
  if (value === undefined) return "not set";
  if (typeof value === "boolean") return value ? "on" : "off";
  return String(value);
}

function OverviewPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.state === "pending");
  const usage = snapshot.usage;

  return (
    <div className="panel-stack">
      <section className="metric-grid" aria-label="Operations summary">
        <Metric label="Active installations" value={String(snapshot.installations.length)} />
        <Metric label="Pending approvals" value={String(pendingApprovals.length)} tone="warning" />
        <Metric label="Executions today" value={String(usage.executions)} />
        <Metric label="Runtime ms today" value={String(usage.runtimeMs)} />
      </section>
      <section className="metric-grid" aria-label="Operational health">
        <Metric
          label="Failure rate"
          value={`${(snapshot.operationalHealth.failureRateBps / 100).toFixed(2)}%`}
          tone={snapshot.operationalHealth.failedExecutions > 0 ? "warning" : "default"}
        />
        <Metric
          label="Budget blocks"
          value={String(snapshot.operationalHealth.budgetExceededExecutions)}
          tone={snapshot.operationalHealth.budgetExceededExecutions > 0 ? "warning" : "default"}
        />
        <Metric label="Timeouts" value={String(snapshot.operationalHealth.timeoutExecutions)} />
        <Metric
          label="Egress denials"
          value={String(snapshot.operationalHealth.egressDeniedExecutions)}
        />
      </section>
      <SchemaMigrationsPanel migrations={snapshot.schemaMigrations} />
      <section className="data-panel">
        <PanelHeader title="Recent executions" detail="Last 24 hours" />
        <ExecutionTable snapshot={snapshot} />
      </section>
    </div>
  );
}

function SchemaMigrationsPanel({
  migrations
}: {
  migrations: DashboardSnapshot["schemaMigrations"];
}) {
  return (
    <section className="data-panel" aria-label="Schema migrations">
      <PanelHeader title="Schema migrations" detail="App-wide compatibility" />
      {migrations.length === 0 ? (
        <p>No schema migrations configured</p>
      ) : (
        <TableViewport label="Schema migration table">
          <table>
            <thead>
              <tr>
                <th>Hook</th>
                <th>Schema version</th>
                <th>Usage</th>
                <th>Blocking installations</th>
                <th>Recommended action</th>
              </tr>
            </thead>
            <tbody>
              {migrations.flatMap((migration) =>
                migration.versions.map((version) => {
                  const blockerLabel = `${String(version.installationCount)} blocking installation${version.installationCount === 1 ? "" : "s"}`;
                  return (
                    <tr key={`${migration.hookName}:${version.version}`}>
                      <td>{migration.hookName}</td>
                      <td>{version.version}</td>
                      <td>{blockerLabel}</td>
                      <td>
                        {version.blockingInstallations.length === 0 ? (
                          "None"
                        ) : (
                          <ul className="compact-list">
                            {version.blockingInstallations.map((blocker) => (
                              <li key={blocker.installationId}>
                                <code>{blocker.installationId}</code>
                                <span>
                                  {blocker.pluginKey}@{blocker.pluginVersion} ·{" "}
                                  {blocker.schemaRange}
                                </span>
                              </li>
                            ))}
                          </ul>
                        )}
                      </td>
                      <td>
                        {version.removable
                          ? `Ready to remove ${version.version}`
                          : `Upgrade blockers before removing ${version.version}`}
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </TableViewport>
      )}
      {migrations.some((migration) => migration.incompatibleInstallations.length > 0) ? (
        <div className="form-error">
          <p>Some installations have no compatible published schema.</p>
          <ul className="compact-list">
            {migrations.flatMap((migration) =>
              migration.incompatibleInstallations.map((blocker) => (
                <li key={`${migration.hookName}:${blocker.installationId}`}>
                  {migration.hookName}: <code>{blocker.installationId}</code> ({blocker.pluginKey}@
                  {blocker.pluginVersion} · {blocker.schemaRange})
                </li>
              ))
            )}
          </ul>
        </div>
      ) : null}
    </section>
  );
}

function InstallationsPanel({
  snapshot,
  loading,
  onLoadMore,
  permissionReview,
  permissionLoading,
  permissionError,
  onPermissionReview,
  canManage,
  onInstallationCommand,
  commandInFlight
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
  permissionReview: InstallationPermissionReview | null;
  permissionLoading: boolean;
  permissionError: string | null;
  onPermissionReview: (id: string) => void;
  canManage: boolean;
  onInstallationCommand: (request: InstallationCommandRequest) => Promise<unknown>;
  commandInFlight: boolean;
}) {
  const [managedInstallationId, setManagedInstallationId] = useState<string | null>(null);
  const managedInstallation = snapshot.installations.find(
    (installation) => installation.id === managedInstallationId
  );
  return (
    <section className="data-panel">
      <PanelHeader title="Installations" detail="Tenant scoped plugins" />
      <TableViewport label="Installation table">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Version</th>
              <th>Priority</th>
              <th>Status</th>
              <th>Review</th>
              {canManage ? <th>Manage</th> : null}
            </tr>
          </thead>
          <tbody>
            {snapshot.installations.map((installation) => (
              <tr key={installation.id}>
                <td>{installation.pluginKey}</td>
                <td>{installation.version}</td>
                <td>{installation.priority}</td>
                <td>
                  <StatusPill status={installation.statusText} />
                </td>
                <td>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => {
                      onPermissionReview(installation.id);
                    }}
                    aria-label={`Permission review for ${installation.pluginKey}`}
                  >
                    Permission review
                  </button>
                </td>
                {canManage ? (
                  <td>
                    <button
                      type="button"
                      className="secondary-button"
                      onClick={() => {
                        setManagedInstallationId(installation.id);
                      }}
                      disabled={commandInFlight}
                      aria-label={`Manage ${installation.pluginKey}`}
                    >
                      Manage
                    </button>
                  </td>
                ) : null}
              </tr>
            ))}
          </tbody>
        </table>
      </TableViewport>
      <LoadMoreButton
        section="installations"
        cursor={snapshot.cursors.installations}
        loading={loading}
        onClick={onLoadMore}
      />
      {permissionLoading ? <div className="loading-panel">Loading permission review</div> : null}
      {permissionError === null ? null : <p className="form-error">{permissionError}</p>}
      {permissionReview === null ? null : <PermissionReviewPanel review={permissionReview} />}
      {managedInstallation === undefined ? null : (
        <InstallationCommandPanel
          key={`${managedInstallation.id}:${String(managedInstallation.revision)}`}
          installation={managedInstallation}
          onCommand={onInstallationCommand}
          commandInFlight={commandInFlight}
        />
      )}
    </section>
  );
}

function InstallationCommandPanel({
  installation,
  onCommand,
  commandInFlight
}: {
  installation: DashboardSnapshot["installations"][number];
  onCommand: (request: InstallationCommandRequest) => Promise<unknown>;
  commandInFlight: boolean;
}) {
  const [enabled, setEnabled] = useState(installation.enabled);
  const [priority, setPriority] = useState(String(installation.priority));
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedPriority = Number(priority);
  const validPriority =
    priority.trim() !== "" &&
    Number.isFinite(parsedPriority) &&
    Number.isSafeInteger(parsedPriority);
  const changed =
    validPriority && (enabled !== installation.enabled || parsedPriority !== installation.priority);

  const confirm = useCallback(() => {
    if (!changed || commandInFlight) return;
    setError(null);
    const request =
      enabled !== installation.enabled && parsedPriority !== installation.priority
        ? {
            id: installation.id,
            expectedRevision: installation.revision,
            enabled,
            priority: parsedPriority
          }
        : enabled !== installation.enabled
          ? { id: installation.id, expectedRevision: installation.revision, enabled }
          : {
              id: installation.id,
              expectedRevision: installation.revision,
              priority: parsedPriority
            };
    void onCommand(request)
      .then(() => {
        setConfirming(false);
      })
      .catch((cause: unknown) => {
        setError(adminMutationErrorMessage(cause, "Installation update unavailable"));
      });
  }, [changed, commandInFlight, enabled, installation, onCommand, parsedPriority]);

  return (
    <section className="data-panel" aria-label="Installation controls">
      <PanelHeader title="Installation controls" detail={installation.pluginKey} />
      <div className="button-row">
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setEnabled(true);
          }}
        >
          Enable installation
        </button>
        <button
          type="button"
          className="secondary-button"
          onClick={() => {
            setEnabled(false);
          }}
        >
          Disable installation
        </button>
      </div>
      <label htmlFor="installation-priority">
        Priority
        <input
          id="installation-priority"
          inputMode="numeric"
          value={priority}
          onChange={(event) => {
            setPriority(event.currentTarget.value);
          }}
        />
      </label>
      <button
        type="button"
        disabled={!changed || commandInFlight}
        onClick={() => {
          setConfirming(true);
        }}
      >
        Review change
      </button>
      {error === null ? null : <p className="form-error">{error}</p>}
      {!confirming ? null : (
        <ModalDialog
          label="Confirm installation change"
          cancelDisabled={commandInFlight}
          onCancel={() => {
            setConfirming(false);
          }}
        >
          <p>
            Change enabled to {String(enabled)} and priority to {String(parsedPriority)}?
          </p>
          <button type="button" onClick={confirm} disabled={commandInFlight}>
            {commandInFlight ? "Saving" : "Confirm change"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            disabled={commandInFlight}
          >
            Cancel
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

function PermissionReviewPanel({ review }: { review: InstallationPermissionReview }) {
  return (
    <section className="data-panel" aria-label="Installation permission review">
      <PanelHeader title="Permission review" detail={`${review.pluginKey} ${review.version}`} />
      <p>
        Egress:{" "}
        {review.egress.mode === "deny"
          ? "denied"
          : `${String(review.egress.allowlistedHostCount)} allowlisted hosts`}
      </p>
      <h3>Configuration fields</h3>
      {review.configFields.length === 0 ? (
        <p>No configuration fields</p>
      ) : (
        <ul>
          {review.configFields.map((field) => (
            <li key={field.name}>
              {field.name} · {field.type} · {field.required ? "required" : "optional"} ·{" "}
              {field.configured ? "configured" : "not configured"} ·{" "}
              {field.hasDefault ? "default available" : "no default"}
            </li>
          ))}
        </ul>
      )}
      <h3>Capabilities</h3>
      {review.capabilities.length === 0 ? (
        <p>No capabilities requested</p>
      ) : (
        <ul>
          {review.capabilities.map((capability) => (
            <li key={capability.name}>
              {capability.name} · {capability.status} ·{" "}
              {capability.scopeKeys.join(", ") || "no scope keys"} ·{" "}
              {capability.configReferences.length === 0
                ? "static scope"
                : `configured by ${capability.configReferences.join(", ")}`}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function VersionsPanel({
  snapshot,
  loading,
  onLoadMore,
  canInstall,
  canRequest,
  installPreview,
  installLoading,
  installError,
  onInstallPreview,
  onInstall,
  onInstallRequest,
  installInFlight,
  tenantId,
  onRollback,
  rollbackInFlight,
  onViewExecutions
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
  canInstall: boolean;
  canRequest: boolean;
  installPreview: InstallPreview | null;
  installLoading: boolean;
  installError: string | null;
  onInstallPreview: (versionId: string) => void;
  onInstall: (request: InstallPluginRequest) => Promise<InstallPluginResult>;
  onInstallRequest: (request: InstallPluginRequest) => Promise<InstallRequestResult>;
  installInFlight: boolean;
  tenantId: string;
  onRollback: (request: RollbackInstallationRequest) => Promise<RollbackInstallationResult>;
  rollbackInFlight: boolean;
  onViewExecutions: () => void;
}) {
  const [rollbackTarget, setRollbackTarget] = useState<{
    installation: DashboardSnapshot["installations"][number];
    version: DashboardSnapshot["pluginVersions"][number];
    idempotencyKey: string;
  } | null>(null);
  const [rollbackResult, setRollbackResult] = useState<RollbackInstallationResult | null>(null);
  const [rollbackError, setRollbackError] = useState<string | null>(null);
  const [rollbackStartedAt, setRollbackStartedAt] = useState<Date | null>(null);
  const [rollbackDurationMs, setRollbackDurationMs] = useState<number | null>(null);

  const confirmRollback = useCallback(() => {
    if (rollbackTarget === null || rollbackInFlight) return;
    const startedAt = new Date();
    const startedTick = performance.now();
    setRollbackError(null);
    setRollbackStartedAt(startedAt);
    setRollbackDurationMs(null);
    void onRollback({
      idempotencyKey: rollbackTarget.idempotencyKey,
      installationId: rollbackTarget.installation.id,
      targetVersionId: rollbackTarget.version.id,
      expectedRevision: rollbackTarget.installation.revision
    })
      .then((result) => {
        setRollbackResult(result);
        setRollbackDurationMs(Math.max(0, Math.round(performance.now() - startedTick)));
        setRollbackTarget(null);
      })
      .catch((cause: unknown) => {
        setRollbackError(
          cause instanceof AdminApiError && cause.code === "installation_revision_conflict"
            ? "Installation changed; version history refreshed"
            : adminMutationErrorMessage(cause, "Rollback unavailable")
        );
      });
  }, [onRollback, rollbackInFlight, rollbackTarget]);

  return (
    <section className="data-panel">
      <PanelHeader title="Versions" detail="Pinned artifacts" />
      <TableViewport label="Plugin version table">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Version</th>
              <th>Artifact</th>
              <th>Published</th>
              <th>Pin</th>
              {canRequest ? <th>Actions</th> : null}
            </tr>
          </thead>
          <tbody>
            {snapshot.pluginVersions.map((version) => {
              const installations = snapshot.installations.filter(
                (installation) => installation.pluginKey === version.pluginKey
              );
              const current = installations.filter(
                (installation) => installation.version === version.version
              );
              const rollbackCandidates = installations.filter(
                (installation) => installation.version !== version.version
              );
              return (
                <tr key={version.id}>
                  <td>{version.pluginKey}</td>
                  <td>{version.version}</td>
                  <td className="mono-cell">{version.artifactHash}</td>
                  <td>{version.createdAt.toISOString()}</td>
                  <td>{current.length === 0 ? "past" : `current (${String(current.length)})`}</td>
                  {canRequest ? (
                    <td>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          onInstallPreview(version.id);
                        }}
                        disabled={installInFlight || installLoading}
                        aria-label={`${canInstall ? "Install" : "Request"} ${version.pluginKey} ${version.version}`}
                      >
                        {canInstall ? "Install" : "Request approval"}
                      </button>
                      {canInstall
                        ? rollbackCandidates.map((installation) => (
                            <button
                              key={installation.id}
                              type="button"
                              className="secondary-button"
                              disabled={rollbackInFlight || installInFlight || installLoading}
                              aria-label={`Rollback ${version.pluginKey} from ${installation.version} to ${version.version}`}
                              onClick={() => {
                                setRollbackResult(null);
                                setRollbackError(null);
                                setRollbackTarget({
                                  installation,
                                  version,
                                  idempotencyKey: crypto.randomUUID()
                                });
                              }}
                            >
                              Rollback
                            </button>
                          ))
                        : null}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </TableViewport>
      <LoadMoreButton
        section="versions"
        cursor={snapshot.cursors.pluginVersions}
        loading={loading}
        onClick={onLoadMore}
      />
      {installLoading ? <div className="loading-panel">Loading installation preview</div> : null}
      {installError === null ? null : <p className="form-error">{installError}</p>}
      {installPreview === null ? null : (
        <InstallFlowPanel
          key={installPreview.versionId}
          preview={installPreview}
          mode={canInstall ? "install" : "request"}
          onSubmit={canInstall ? onInstall : onInstallRequest}
          installInFlight={installInFlight}
        />
      )}
      {rollbackError === null ? null : <p className="form-error">{rollbackError}</p>}
      {rollbackTarget === null ? null : (
        <ModalDialog
          label="Confirm plugin rollback"
          cancelDisabled={rollbackInFlight}
          onCancel={() => {
            setRollbackTarget(null);
          }}
        >
          <p>Tenant: {tenantId}</p>
          <p>Plugin: {rollbackTarget.version.pluginKey}</p>
          <p>From: {rollbackTarget.installation.version}</p>
          <p>To: {rollbackTarget.version.version}</p>
          <button type="button" onClick={confirmRollback} disabled={rollbackInFlight}>
            {rollbackInFlight ? "Rolling back" : "Confirm rollback"}
          </button>
          <button
            type="button"
            disabled={rollbackInFlight}
            onClick={() => {
              setRollbackTarget(null);
            }}
          >
            Cancel
          </button>
        </ModalDialog>
      )}
      {rollbackResult === null ? null : (
        <section aria-label="Rollback result">
          <h3>Rollback completed</h3>
          <p>
            {rollbackResult.pluginKey}: {rollbackResult.fromVersion} → {rollbackResult.toVersion}
          </p>
          <p>
            Audit: <span className="mono-cell">{rollbackResult.auditId}</span>
          </p>
          {rollbackStartedAt === null ? null : <p>Started: {rollbackStartedAt.toISOString()}</p>}
          <p>Completed: {rollbackResult.completedAt.toISOString()}</p>
          {rollbackDurationMs === null ? null : (
            <p>UI rollback duration: {String(rollbackDurationMs)} ms</p>
          )}
          <button type="button" className="secondary-button" onClick={onViewExecutions}>
            View execution log
          </button>
        </section>
      )}
    </section>
  );
}

function InstallFlowPanel({
  preview,
  mode,
  onSubmit,
  installInFlight
}: {
  preview: InstallPreview;
  mode: "install" | "request";
  onSubmit: (request: InstallPluginRequest) => Promise<InstallPluginResult | InstallRequestResult>;
  installInFlight: boolean;
}) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmedCapabilities, setConfirmedCapabilities] = useState<readonly string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [priority, setPriority] = useState("100");
  const [confirming, setConfirming] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [requestResult, setRequestResult] = useState<InstallRequestResult | null>(null);
  const parsed = parseInstallConfig(preview, values);
  const parsedPriority = Number(priority);
  const validPriority = priority.trim() !== "" && Number.isSafeInteger(parsedPriority);
  const allCapabilitiesConfirmed = preview.capabilities.every((capability) =>
    confirmedCapabilities.includes(capability.name)
  );
  const canReview = parsed.ok && validPriority && allCapabilitiesConfirmed && !installInFlight;

  const confirm = useCallback(() => {
    if (!parsed.ok || !validPriority || !allCapabilitiesConfirmed || installInFlight) return;
    setSubmitError(null);
    void onSubmit({
      idempotencyKey: idempotencyKey.current,
      versionId: preview.versionId,
      config: parsed.config,
      confirmedCapabilities,
      enabled,
      priority: parsedPriority
    })
      .then((result) => {
        if (isInstallRequestResult(result)) setRequestResult(result);
        setConfirming(false);
      })
      .catch((cause: unknown) => {
        setSubmitError(adminMutationErrorMessage(cause, "Plugin installation unavailable"));
      });
  }, [
    allCapabilitiesConfirmed,
    confirmedCapabilities,
    enabled,
    installInFlight,
    onSubmit,
    parsed,
    parsedPriority,
    preview.versionId,
    validPriority
  ]);

  return (
    <section
      className="data-panel"
      aria-label={mode === "install" ? "Install plugin" : "Request installation approval"}
    >
      <PanelHeader
        title={mode === "install" ? "Install plugin" : "Request installation approval"}
        detail={`${preview.pluginKey} ${preview.version}`}
      />
      <p>
        Egress:{" "}
        {preview.egress.mode === "deny"
          ? "denied"
          : `${String(preview.egress.allowlistedHostCount)} allowlisted hosts`}
      </p>
      <h3>Configuration</h3>
      {preview.configFields.length === 0 ? <p>No configuration required</p> : null}
      {preview.configFields.map((field) => {
        const label = `${field.name} (${field.required ? "required" : "optional"})`;
        const value = values[field.name] ?? "";
        return (
          <label key={field.name} htmlFor={`install-config-${field.name}`}>
            {label}
            {field.type === "boolean" ? (
              <select
                id={`install-config-${field.name}`}
                aria-label={label}
                value={value}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setValues((current) => ({ ...current, [field.name]: nextValue }));
                }}
              >
                <option value="">{field.hasDefault ? "Use manifest default" : "Not set"}</option>
                <option value="true">True</option>
                <option value="false">False</option>
              </select>
            ) : (
              <input
                id={`install-config-${field.name}`}
                aria-label={label}
                type={field.type === "number" ? "number" : "text"}
                value={value}
                required={field.required}
                onChange={(event) => {
                  const nextValue = event.currentTarget.value;
                  setValues((current) => ({ ...current, [field.name]: nextValue }));
                }}
              />
            )}
          </label>
        );
      })}
      {!parsed.ok ? <p className="form-error">{parsed.message}</p> : null}
      <h3>Requested capabilities</h3>
      {preview.capabilities.length === 0 ? <p>No capabilities requested</p> : null}
      {preview.capabilities.map((capability) => (
        <label key={capability.name} htmlFor={`install-capability-${capability.name}`}>
          <input
            id={`install-capability-${capability.name}`}
            type="checkbox"
            aria-label={`Confirm ${capability.name}`}
            checked={confirmedCapabilities.includes(capability.name)}
            onChange={(event) => {
              const checked = event.currentTarget.checked;
              setConfirmedCapabilities((current) =>
                checked
                  ? [...current, capability.name]
                  : current.filter((name) => name !== capability.name)
              );
            }}
          />
          Confirm {capability.name}
          <span>
            {capability.scopeKeys.join(", ") || "no scope keys"} ·{" "}
            {capability.configReferences.length === 0
              ? "static scope"
              : `configured by ${capability.configReferences.join(", ")}`}
          </span>
        </label>
      ))}
      <label htmlFor="install-enabled">
        <input
          id="install-enabled"
          type="checkbox"
          checked={enabled}
          onChange={(event) => {
            setEnabled(event.currentTarget.checked);
          }}
        />
        Enable immediately
      </label>
      <label htmlFor="install-priority">
        Installation priority
        <input
          id="install-priority"
          inputMode="numeric"
          value={priority}
          onChange={(event) => {
            setPriority(event.currentTarget.value);
          }}
        />
      </label>
      <button
        type="button"
        disabled={!canReview}
        onClick={() => {
          setConfirming(true);
        }}
      >
        {mode === "install" ? "Review installation" : "Review installation request"}
      </button>
      {submitError === null ? null : <p className="form-error">{submitError}</p>}
      {requestResult === null ? null : (
        <section aria-label="Installation approval request result">
          <h3>Approval request pending</h3>
          <p className="mono-cell">{requestResult.approvalId}</p>
          <p>Expires: {requestResult.expiresAt.toISOString()}</p>
        </section>
      )}
      {!confirming ? null : (
        <ModalDialog
          label={
            mode === "install"
              ? "Confirm plugin installation"
              : "Confirm installation approval request"
          }
          cancelDisabled={installInFlight}
          onCancel={() => {
            setConfirming(false);
          }}
        >
          <p>
            Install {preview.pluginKey} {preview.version} with {String(preview.capabilities.length)}{" "}
            confirmed capabilities?
          </p>
          <button type="button" onClick={confirm} disabled={installInFlight}>
            {installInFlight
              ? mode === "install"
                ? "Installing"
                : "Submitting request"
              : mode === "install"
                ? "Confirm installation"
                : "Submit approval request"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            disabled={installInFlight}
          >
            Cancel
          </button>
        </ModalDialog>
      )}
    </section>
  );
}

function parseInstallConfig(
  preview: InstallPreview,
  values: Readonly<Record<string, string>>
):
  | { ok: true; config: Record<string, string | number | boolean> }
  | { ok: false; message: string } {
  const config: Record<string, string | number | boolean> = {};
  for (const field of preview.configFields) {
    const raw = values[field.name] ?? "";
    if (raw === "") {
      if (field.required) return { ok: false, message: `${field.name} is required` };
      continue;
    }
    if (field.type === "number") {
      const number = Number(raw);
      if (!Number.isFinite(number)) return { ok: false, message: `${field.name} must be a number` };
      config[field.name] = number;
    } else if (field.type === "boolean") {
      config[field.name] = raw === "true";
    } else {
      config[field.name] = raw;
    }
  }
  return { ok: true, config };
}

function isInstallRequestResult(value: unknown): value is InstallRequestResult {
  return (
    typeof value === "object" &&
    value !== null &&
    "approvalId" in value &&
    typeof value.approvalId === "string" &&
    "state" in value &&
    value.state === "pending" &&
    "expiresAt" in value &&
    value.expiresAt instanceof Date
  );
}

function ApprovalsPanel({
  snapshot,
  tenantId,
  canDecide,
  loading,
  onLoadMore,
  onDecision
}: {
  snapshot: DashboardSnapshot;
  tenantId: string;
  canDecide: boolean;
  loading: boolean;
  onLoadMore: () => void;
  onDecision: (request: ApprovalDecisionRequest) => Promise<ApprovalDecisionResult>;
}) {
  const [reason, setReason] = useState("");
  const [confirmation, setConfirmation] = useState<{
    approval: ApprovalView;
    decision: "approved" | "rejected";
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [result, setResult] = useState<ApprovalDecisionResult | null>(null);

  const confirmDecision = useCallback(() => {
    if (confirmation === null || submitting) return;
    setSubmitting(true);
    setDecisionError(null);
    void onDecision({
      approvalId: confirmation.approval.id,
      decision: confirmation.decision,
      ...(reason.trim() === "" ? {} : { reason: reason.trim() })
    })
      .then((nextResult) => {
        setResult(nextResult);
        setConfirmation(null);
        setReason("");
      })
      .catch((cause: unknown) => {
        setDecisionError(adminMutationErrorMessage(cause, "Approval decision unavailable"));
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [confirmation, onDecision, reason, submitting]);

  return (
    <section className="data-panel">
      <PanelHeader title="Approval queue" detail="Manager decisions" />
      <p className="tenant-context">Tenant: {tenantId}</p>
      <div className="approval-list">
        {snapshot.approvals.map((approval) => (
          <article className="approval-row" key={approval.id}>
            <div>
              <h2>{approval.id}</h2>
              <p>{approval.resumeHook}</p>
            </div>
            <StatusPill status={approval.state} />
            <div className="button-row">
              <button
                type="button"
                disabled={!canDecide || approval.state !== "pending" || submitting}
                onClick={() => {
                  setResult(null);
                  setConfirmation({ approval, decision: "approved" });
                }}
              >
                Approve
              </button>
              <button
                type="button"
                disabled={!canDecide || approval.state !== "pending" || submitting}
                onClick={() => {
                  setResult(null);
                  setConfirmation({ approval, decision: "rejected" });
                }}
              >
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
      {decisionError === null ? null : <p className="form-error">{decisionError}</p>}
      {confirmation === null ? null : (
        <ModalDialog
          label="Confirm approval decision"
          cancelDisabled={submitting}
          onCancel={() => {
            setConfirmation(null);
            setReason("");
          }}
        >
          <p>Tenant: {tenantId}</p>
          <p>Approval: {confirmation.approval.id}</p>
          <p>Decision: {confirmation.decision}</p>
          <label>
            Decision reason
            <input
              value={reason}
              maxLength={1000}
              onChange={(event) => {
                setReason(event.target.value);
              }}
            />
          </label>
          <button type="button" disabled={submitting} onClick={confirmDecision}>
            {submitting ? "Deciding" : "Confirm approval"}
          </button>
          <button
            type="button"
            disabled={submitting}
            onClick={() => {
              setConfirmation(null);
              setReason("");
            }}
          >
            Cancel
          </button>
        </ModalDialog>
      )}
      {result === null ? null : (
        <section aria-label="Approval decision result">
          <h3>Approval {result.state}</h3>
          <p>
            Audit: <span className="mono-cell">{result.auditId}</span>
          </p>
          <p>Decided: {result.decidedAt.toISOString()}</p>
        </section>
      )}
      <LoadMoreButton
        section="approvals"
        cursor={snapshot.cursors.approvals}
        loading={loading}
        onClick={onLoadMore}
      />
    </section>
  );
}

function ExecutionsPanel({
  snapshot,
  tenantId,
  loading,
  onLoadMore,
  onSearch,
  onDetail
}: {
  snapshot: DashboardSnapshot;
  tenantId: string;
  loading: boolean;
  onLoadMore: () => void;
  onSearch: AdminApiClient["searchExecutions"];
  onDetail: AdminApiClient["getExecutionDetail"];
}) {
  const [pluginId, setPluginId] = useState("");
  const [hookName, setHookName] = useState("");
  const [status, setStatus] = useState<"" | ExecutionView["status"]>("");
  const [results, setResults] = useState<readonly ExecutionView[] | null>(null);
  const [resultSetVersion, setResultSetVersion] = useState(0);
  const [filters, setFilters] = useState<ExecutionSearchRequest>({});
  const [nextCursor, setNextCursor] = useState<string | undefined>();
  const [searchLoading, setSearchLoading] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [detail, setDetail] = useState<ExecutionDetailView | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const searchRequest = useRef(0);
  const detailRequest = useRef(0);

  const runSearch = useCallback(
    (request: ExecutionSearchRequest, append: boolean) => {
      const requestId = searchRequest.current + 1;
      searchRequest.current = requestId;
      setSearchLoading(true);
      setSearchError(null);
      void onSearch(request)
        .then((page) => {
          if (searchRequest.current !== requestId) return;
          if (!append) setResultSetVersion((current) => current + 1);
          setResults((current) =>
            append && current !== null
              ? [
                  ...current,
                  ...page.items.filter((item) => !current.some(({ id }) => id === item.id))
                ]
              : page.items
          );
          setNextCursor(page.nextCursor);
        })
        .catch(() => {
          if (searchRequest.current === requestId) setSearchError("Execution search unavailable");
        })
        .finally(() => {
          if (searchRequest.current === requestId) setSearchLoading(false);
        });
    },
    [onSearch]
  );

  const submitSearch = useCallback(() => {
    const request: ExecutionSearchRequest = {
      ...(pluginId.trim() === "" ? {} : { pluginId: pluginId.trim() }),
      ...(hookName.trim() === "" ? {} : { hookName: hookName.trim() }),
      ...(status === "" ? {} : { status })
    };
    setFilters(request);
    setDetail(null);
    setDetailError(null);
    runSearch(request, false);
  }, [hookName, pluginId, runSearch, status]);

  const openDetail = useCallback(
    (id: string) => {
      const requestId = detailRequest.current + 1;
      detailRequest.current = requestId;
      setDetailLoading(true);
      setDetailError(null);
      setDetail(null);
      void onDetail(id)
        .then((nextDetail) => {
          if (detailRequest.current === requestId) setDetail(nextDetail);
        })
        .catch(() => {
          if (detailRequest.current === requestId) setDetailError("Execution detail unavailable");
        })
        .finally(() => {
          if (detailRequest.current === requestId) setDetailLoading(false);
        });
    },
    [onDetail]
  );

  const visibleExecutions = results ?? snapshot.executions;
  const visibleCursor = results === null ? snapshot.cursors.executions : nextCursor;

  return (
    <section className="data-panel">
      <PanelHeader title="Executions" detail="Hook activity" />
      <p className="tenant-context">Tenant: {tenantId}</p>
      <form
        className="execution-filters"
        onSubmit={(event) => {
          event.preventDefault();
          submitSearch();
        }}
      >
        <label>
          Plugin ID
          <input
            value={pluginId}
            onChange={(event) => {
              setPluginId(event.target.value);
            }}
          />
        </label>
        <label>
          Hook
          <input
            value={hookName}
            onChange={(event) => {
              setHookName(event.target.value);
            }}
          />
        </label>
        <label>
          Status
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value as "" | ExecutionView["status"]);
            }}
          >
            <option value="">All statuses</option>
            <option value="success">success</option>
            <option value="error">error</option>
            <option value="timeout">timeout</option>
            <option value="egress_denied">egress_denied</option>
            <option value="budget_exceeded">budget_exceeded</option>
          </select>
        </label>
        <button type="submit" disabled={searchLoading}>
          Search executions
        </button>
      </form>
      {searchError === null ? null : <p className="form-error">{searchError}</p>}
      <ExecutionTable
        executions={visibleExecutions}
        resetKey={resultSetVersion}
        onView={openDetail}
      />
      <LoadMoreButton
        section="executions"
        cursor={visibleCursor}
        loading={loading || searchLoading}
        onClick={() => {
          if (results === null) onLoadMore();
          else if (nextCursor !== undefined) runSearch({ ...filters, cursor: nextCursor }, true);
        }}
      />
      {detailLoading ? <p className="detail-state">Loading execution detail</p> : null}
      {detailError === null ? null : <p className="form-error">{detailError}</p>}
      {detail === null ? null : <ExecutionDetail detail={detail} />}
    </section>
  );
}

function ExecutionDetail({ detail }: { detail: ExecutionDetailView }) {
  return (
    <section className="execution-detail" aria-label={`Execution detail ${detail.id}`}>
      <h3>{detail.id}</h3>
      <dl>
        <div>
          <dt>Plugin</dt>
          <dd>{detail.pluginId}</dd>
        </div>
        <div>
          <dt>Hook</dt>
          <dd>{detail.hookName}</dd>
        </div>
        <div>
          <dt>Status</dt>
          <dd>{detail.status}</dd>
        </div>
        <div>
          <dt>Error code</dt>
          <dd>{detail.errorCode ?? "none"}</dd>
        </div>
      </dl>
      <h4>Capability calls</h4>
      {detail.capabilityCalls.length === 0 ? (
        <p>none</p>
      ) : (
        <ul>
          {detail.capabilityCalls.map((call) => (
            <li key={`${call.name}:${call.status}`}>
              {call.name} — {call.status}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function LoadMoreButton({
  section,
  cursor,
  loading,
  onClick
}: {
  section: string;
  cursor: string | undefined;
  loading: boolean;
  onClick: () => void;
}) {
  if (cursor === undefined) {
    return null;
  }
  return (
    <button type="button" className="secondary-button" disabled={loading} onClick={onClick}>
      {loading ? `Loading more ${section}` : `Load more ${section}`}
    </button>
  );
}

function preserveAuditSlice(
  current: DashboardSnapshot | null,
  refreshed: DashboardSnapshot
): DashboardSnapshot {
  if (current === null) return refreshed;
  const cursors = { ...refreshed.cursors };
  const auditCursor = current.cursors.auditEvents;
  if (auditCursor === undefined) {
    delete cursors.auditEvents;
  } else {
    cursors.auditEvents = auditCursor;
  }
  return {
    ...refreshed,
    auditEvents: current.auditEvents,
    providerConnections: current.providerConnections,
    cursors
  };
}

function appendPage(snapshot: DashboardSnapshot, page: DashboardSectionPage): DashboardSnapshot {
  const cursors: DashboardSnapshot["cursors"] =
    page.nextCursor === undefined
      ? Object.fromEntries(
          Object.entries(snapshot.cursors).filter(([section]) => section !== page.section)
        )
      : { ...snapshot.cursors, [page.section]: page.nextCursor };

  switch (page.section) {
    case "installations":
      return { ...snapshot, installations: [...snapshot.installations, ...page.items], cursors };
    case "pluginVersions":
      return { ...snapshot, pluginVersions: [...snapshot.pluginVersions, ...page.items], cursors };
    case "approvals":
      return { ...snapshot, approvals: [...snapshot.approvals, ...page.items], cursors };
    case "executions":
      return { ...snapshot, executions: [...snapshot.executions, ...page.items], cursors };
    case "auditEvents":
      return { ...snapshot, auditEvents: [...snapshot.auditEvents, ...page.items], cursors };
  }
}

function Metric({
  label,
  value,
  tone = "default"
}: {
  label: string;
  value: string;
  tone?: "default" | "warning";
}) {
  return (
    <div className={`metric-panel ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function PanelHeader({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="panel-header">
      <h2>{title}</h2>
      <span>{detail}</span>
    </div>
  );
}

function TableViewport({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

function ModalDialog({
  label,
  children,
  cancelDisabled,
  onCancel
}: {
  label: string;
  children: ReactNode;
  cancelDisabled: boolean;
  onCancel: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const returnTarget =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    const frame = requestAnimationFrame(() => {
      focusableDialogElements(dialogRef.current)[0]?.focus();
    });
    return () => {
      cancelAnimationFrame(frame);
      if (returnTarget?.isConnected === true) returnTarget.focus();
    };
  }, []);

  const trapFocus = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== "Tab") return;
    const focusable = focusableDialogElements(dialogRef.current);
    const first = focusable[0];
    const last = focusable.at(-1);
    if (first === undefined || last === undefined) return;
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }, []);

  return (
    <div
      ref={dialogRef}
      role="dialog"
      aria-modal="true"
      aria-label={label}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !cancelDisabled) {
          event.preventDefault();
          onCancel();
          return;
        }
        trapFocus(event);
      }}
    >
      {children}
    </div>
  );
}

function focusableDialogElements(dialog: HTMLDivElement | null): HTMLElement[] {
  if (dialog === null) return [];
  // Dialog focus must stay on interactive, enabled controls; hidden or disabled actions cannot be
  // safe focus targets while a privileged operation is in flight.
  return Array.from(
    dialog.querySelectorAll<HTMLElement>(
      'button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
    )
  ).filter((element) => element.getClientRects().length > 0);
}

function adminMutationErrorMessage(cause: unknown, fallback: string): string {
  if (
    cause instanceof AdminApiError &&
    cause.status === 429 &&
    cause.retryAfterSeconds !== undefined
  ) {
    // Mutations are never retried automatically: waiting for an explicit user action avoids
    // duplicate writes and naturally spreads retries instead of creating a synchronized burst.
    return `Too many changes. Retry in ${String(cause.retryAfterSeconds)} seconds`;
  }
  return fallback;
}

function titleForRoute(route: AdminRoute): string {
  return routeItems.find((item) => item.route === route)?.label ?? "Overview";
}
