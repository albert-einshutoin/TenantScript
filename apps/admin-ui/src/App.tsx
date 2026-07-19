import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createUnavailableAdminApiClient,
  AdminApiError,
  type AdminApiClient,
  type AdminSession,
  type DashboardSectionPage,
  type DashboardSnapshot,
  type InstallationCommandRequest,
  type InstallationPermissionReview
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
  const permissionRequest = useRef(0);

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
                      statusText: updated.enabled ? "enabled" : "disabled"
                    }
                  : installation
              )
            }
      );
      return updated;
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
  onInstallationCommand
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
        />
      );
    case "versions":
      return (
        <VersionsPanel
          snapshot={snapshot}
          loading={loadingSection === "pluginVersions"}
          onLoadMore={() => {
            onLoadMore("pluginVersions");
          }}
        />
      );
    case "approvals":
      return (
        <ApprovalsPanel
          snapshot={snapshot}
          canDecide={session.role === "manager"}
          loading={loadingSection === "approvals"}
          onLoadMore={() => {
            onLoadMore("approvals");
          }}
        />
      );
    case "executions":
      return (
        <ExecutionsPanel
          snapshot={snapshot}
          loading={loadingSection === "executions"}
          onLoadMore={() => {
            onLoadMore("executions");
          }}
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
  onInstallationCommand
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
          key={managedInstallation.id}
          installation={managedInstallation}
          onCommand={onInstallationCommand}
        />
      )}
    </section>
  );
}

function InstallationCommandPanel({
  installation,
  onCommand
}: {
  installation: DashboardSnapshot["installations"][number];
  onCommand: (request: InstallationCommandRequest) => Promise<unknown>;
}) {
  const [enabled, setEnabled] = useState(installation.enabled);
  const [priority, setPriority] = useState(String(installation.priority));
  const [confirming, setConfirming] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const parsedPriority = Number(priority);
  const validPriority =
    priority.trim() !== "" && Number.isFinite(parsedPriority) && Number.isInteger(parsedPriority);
  const changed =
    validPriority && (enabled !== installation.enabled || parsedPriority !== installation.priority);

  const confirm = useCallback(() => {
    if (!changed || submitting) return;
    setSubmitting(true);
    setError(null);
    void onCommand({ id: installation.id, enabled, priority: parsedPriority })
      .then(() => {
        setConfirming(false);
      })
      .catch(() => {
        setError("Installation update unavailable");
      })
      .finally(() => {
        setSubmitting(false);
      });
  }, [changed, enabled, installation.id, onCommand, parsedPriority, submitting]);

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
        disabled={!changed || submitting}
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
          <button type="button" onClick={confirm} disabled={submitting}>
            {submitting ? "Saving" : "Confirm change"}
          </button>
          <button
            type="button"
            onClick={() => {
              setConfirming(false);
            }}
            disabled={submitting}
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
  onLoadMore
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
}) {
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
            </tr>
          </thead>
          <tbody>
            {snapshot.pluginVersions.map((version) => (
              <tr key={version.id}>
                <td>{version.pluginId}</td>
                <td>{version.version}</td>
                <td className="mono-cell">{version.artifactHash}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <LoadMoreButton
        section="versions"
        cursor={snapshot.cursors.pluginVersions}
        loading={loading}
        onClick={onLoadMore}
      />
    </section>
  );
}

function ApprovalsPanel({
  snapshot,
  canDecide,
  loading,
  onLoadMore
}: {
  snapshot: DashboardSnapshot;
  canDecide: boolean;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section className="data-panel">
      <PanelHeader title="Approval queue" detail="Manager decisions" />
      <div className="approval-list">
        {snapshot.approvals.map((approval) => (
          <article className="approval-row" key={approval.id}>
            <div>
              <h2>{approval.id}</h2>
              <p>{approval.resumeHook}</p>
            </div>
            <StatusPill status={approval.state} />
            <div className="button-row">
              <button type="button" disabled={!canDecide || approval.state !== "pending"}>
                Approve
              </button>
              <button type="button" disabled={!canDecide || approval.state !== "pending"}>
                Reject
              </button>
            </div>
          </article>
        ))}
      </div>
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
  loading,
  onLoadMore
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
}) {
  return (
    <section className="data-panel">
      <PanelHeader title="Executions" detail="Hook activity" />
      <ExecutionTable snapshot={snapshot} />
      <LoadMoreButton
        section="executions"
        cursor={snapshot.cursors.executions}
        loading={loading}
        onClick={onLoadMore}
      />
    </section>
  );
}

function ExecutionTable({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Hook</th>
            <th>Plugin</th>
            <th>Status</th>
            <th>Duration</th>
            <th>Capabilities</th>
          </tr>
        </thead>
        <tbody>
          {snapshot.executions.map((execution) => (
            <tr key={execution.id}>
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
            </tr>
          ))}
        </tbody>
      </table>
    </div>
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

function titleForRoute(route: AdminRoute): string {
  return routeItems.find((item) => item.route === route)?.label ?? "Overview";
}
