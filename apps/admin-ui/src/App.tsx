import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createUnavailableAdminApiClient,
  AdminApiError,
  type AdminApiClient,
  type AdminSession,
  type DashboardSectionPage,
  type DashboardSnapshot,
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
      setPermissionLoading(true);
      setPermissionError(null);
      setPermissionReview(null);
      void client
        .getInstallationPermissionReview(id)
        .then(setPermissionReview)
        .catch(() => {
          setPermissionError("Permission review unavailable");
        })
        .finally(() => {
          setPermissionLoading(false);
        });
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
  onPermissionReview
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
  onPermissionReview
}: {
  snapshot: DashboardSnapshot;
  loading: boolean;
  onLoadMore: () => void;
  permissionReview: InstallationPermissionReview | null;
  permissionLoading: boolean;
  permissionError: string | null;
  onPermissionReview: (id: string) => void;
}) {
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
              {field.configured ? "configured" : "not configured"}
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
              {capability.scopeKeys.join(", ") || "no scope keys"}
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
