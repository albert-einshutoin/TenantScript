import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  type InstallPreview,
  type InstallationCommandRequest,
  type InstallationPermissionReview,
  type RollbackInstallationRequest,
  type RollbackInstallationResult
} from "./api-client.js";
import type { AdminDashboardSection } from "@tenantscript/control-plane";
import { type AdminRoute, useHashRoute } from "./router.js";

const defaultClient = createUnavailableAdminApiClient();

export function App({ client = defaultClient }: { client?: AdminApiClient }) {
  const [session, setSession] = useState<AdminSession | null>(null);

  return (
    <main className="app-shell">
      {session === null ? (
        <LoginPanel client={client} onLogin={setSession} />
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
    </main>
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
    void client
      .getDashboard(session)
      .then((nextSnapshot) => {
        if (active) {
          setSnapshot(nextSnapshot);
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
          setSnapshot(await client.getDashboard(session));
        }
        throw commandError;
      } finally {
        setCommandInFlight(false);
      }
    },
    [client, session]
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
        setSnapshot(await client.getDashboard(session));
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
    [client, session]
  );

  const rollbackInstallation = useCallback(
    async (request: RollbackInstallationRequest) => {
      setRollbackInFlight(true);
      try {
        const result = await client.rollbackInstallation(request);
        // A fresh snapshot is the completion signal: it proves the current pin changed on the
        // server and avoids presenting a local optimistic version as an operational rollback.
        setSnapshot(await client.getDashboard(session));
        return result;
      } catch (cause) {
        if (
          cause instanceof AdminApiError &&
          cause.status === 409 &&
          cause.code === "installation_revision_conflict"
        ) {
          setSnapshot(await client.getDashboard(session));
        }
        throw cause;
      } finally {
        setRollbackInFlight(false);
      }
    },
    [client, session]
  );

  const decideApproval = useCallback(
    async (request: ApprovalDecisionRequest) => {
      const result = await client.decideApproval(request);
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
    [client]
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
      <div className="workspace">
        <header className="topbar">
          <div>
            <p className="eyebrow">Acme Production</p>
            <h1>{titleForRoute(route)}</h1>
          </div>
          <div className="session-chip" aria-label={`signed in as ${session.role}`}>
            <span>{session.subject}</span>
            <strong>{session.role}</strong>
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
      </div>
    </section>
  );
}

const routeItems: readonly { route: AdminRoute; label: string }[] = [
  { route: "overview", label: "Overview" },
  { route: "installations", label: "Installations" },
  { route: "versions", label: "Versions" },
  { route: "approvals", label: "Approval queue" },
  { route: "executions", label: "Executions" }
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
  onInstall: (request: InstallPluginRequest) => Promise<unknown>;
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
          canManage={session.role === "manager"}
          onInstallationCommand={onInstallationCommand}
          commandInFlight={commandInFlight}
        />
      );
    case "versions":
      return (
        <VersionsPanel
          snapshot={snapshot}
          canInstall={session.role === "manager"}
          loading={loadingSection === "pluginVersions"}
          onLoadMore={() => {
            onLoadMore("pluginVersions");
          }}
          installPreview={installPreview}
          installLoading={installLoading}
          installError={installError}
          onInstallPreview={onInstallPreview}
          onInstall={onInstall}
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
          canDecide={session.role === "manager"}
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
  }
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
      <section className="data-panel">
        <PanelHeader title="Recent executions" detail="Last 24 hours" />
        <ExecutionTable snapshot={snapshot} />
      </section>
    </div>
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
      <div className="table-wrap">
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
      </div>
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
        <div role="dialog" aria-modal="true" aria-label="Confirm installation change">
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
        </div>
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
  installPreview,
  installLoading,
  installError,
  onInstallPreview,
  onInstall,
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
  installPreview: InstallPreview | null;
  installLoading: boolean;
  installError: string | null;
  onInstallPreview: (versionId: string) => void;
  onInstall: (request: InstallPluginRequest) => Promise<unknown>;
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
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Version</th>
              <th>Artifact</th>
              <th>Published</th>
              <th>Pin</th>
              {canInstall ? <th>Actions</th> : null}
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
                  {canInstall ? (
                    <td>
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          onInstallPreview(version.id);
                        }}
                        disabled={installInFlight || installLoading}
                        aria-label={`Install ${version.pluginKey} ${version.version}`}
                      >
                        Install
                      </button>
                      {rollbackCandidates.map((installation) => (
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
                      ))}
                    </td>
                  ) : null}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
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
          onInstall={onInstall}
          installInFlight={installInFlight}
        />
      )}
      {rollbackError === null ? null : <p className="form-error">{rollbackError}</p>}
      {rollbackTarget === null ? null : (
        <div role="dialog" aria-modal="true" aria-label="Confirm plugin rollback">
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
        </div>
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
  onInstall,
  installInFlight
}: {
  preview: InstallPreview;
  onInstall: (request: InstallPluginRequest) => Promise<unknown>;
  installInFlight: boolean;
}) {
  const idempotencyKey = useRef(crypto.randomUUID());
  const [values, setValues] = useState<Record<string, string>>({});
  const [confirmedCapabilities, setConfirmedCapabilities] = useState<readonly string[]>([]);
  const [enabled, setEnabled] = useState(false);
  const [priority, setPriority] = useState("100");
  const [confirming, setConfirming] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
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
    void onInstall({
      idempotencyKey: idempotencyKey.current,
      versionId: preview.versionId,
      config: parsed.config,
      confirmedCapabilities,
      enabled,
      priority: parsedPriority
    })
      .then(() => {
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
    onInstall,
    parsed,
    parsedPriority,
    preview.versionId,
    validPriority
  ]);

  return (
    <section className="data-panel" aria-label="Install plugin">
      <PanelHeader title="Install plugin" detail={`${preview.pluginKey} ${preview.version}`} />
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
        Review installation
      </button>
      {submitError === null ? null : <p className="form-error">{submitError}</p>}
      {!confirming ? null : (
        <div role="dialog" aria-modal="true" aria-label="Confirm plugin installation">
          <p>
            Install {preview.pluginKey} {preview.version} with {String(preview.capabilities.length)}{" "}
            confirmed capabilities?
          </p>
          <button type="button" onClick={confirm} disabled={installInFlight}>
            {installInFlight ? "Installing" : "Confirm installation"}
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
        </div>
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
        <div role="dialog" aria-modal="true" aria-label="Confirm approval decision">
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
        </div>
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
      <ExecutionTable executions={visibleExecutions} onView={openDetail} />
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

function ExecutionTable({
  snapshot,
  executions = snapshot?.executions ?? [],
  onView
}: {
  snapshot?: DashboardSnapshot;
  executions?: readonly ExecutionView[];
  onView?: (id: string) => void;
}) {
  return (
    <div className="table-wrap">
      <table>
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
          {executions.map((execution) => (
            <tr key={execution.id}>
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
        </tbody>
      </table>
    </div>
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

function StatusPill({ status }: { status: string }) {
  const tone = useMemo(() => statusTone(status), [status]);
  return <span className={`status-pill ${tone}`}>{status}</span>;
}

function statusTone(status: string): "ok" | "warning" | "critical" | "neutral" {
  if (status === "success" || status === "enabled" || status === "approved") {
    return "ok";
  }
  if (status === "pending") {
    return "warning";
  }
  if (status === "error" || status === "timeout" || status === "egress_denied") {
    return "critical";
  }
  return "neutral";
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
