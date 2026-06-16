import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createDemoAdminApiClient,
  type AdminApiClient,
  type AdminSession,
  type DashboardSnapshot
} from "./api-client.js";
import { type AdminRoute, useHashRoute } from "./router.js";

const defaultClient = createDemoAdminApiClient();

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
      .catch(() => {
        setError("Token rejected");
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
            autoComplete="off"
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
          <RoutePanel route={route} session={session} snapshot={snapshot} />
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
  snapshot
}: {
  route: AdminRoute;
  session: AdminSession;
  snapshot: DashboardSnapshot;
}) {
  switch (route) {
    case "overview":
      return <OverviewPanel snapshot={snapshot} />;
    case "installations":
      return <InstallationsPanel snapshot={snapshot} />;
    case "versions":
      return <VersionsPanel snapshot={snapshot} />;
    case "approvals":
      return <ApprovalsPanel snapshot={snapshot} canDecide={session.role === "manager"} />;
    case "executions":
      return <ExecutionsPanel snapshot={snapshot} />;
  }
}

function OverviewPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.state === "pending");
  const usage = snapshot.usage[0];

  return (
    <div className="panel-stack">
      <section className="metric-grid" aria-label="Operations summary">
        <Metric label="Active installations" value={String(snapshot.installations.length)} />
        <Metric label="Pending approvals" value={String(pendingApprovals.length)} tone="warning" />
        <Metric label="Executions today" value={String(usage?.executions ?? 0)} />
        <Metric label="CPU ms today" value={String(usage?.cpuMs ?? 0)} />
      </section>
      <section className="data-panel">
        <PanelHeader title="Recent executions" detail="Last 24 hours" />
        <ExecutionTable snapshot={snapshot} />
      </section>
    </div>
  );
}

function InstallationsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <section className="data-panel">
      <PanelHeader title="Installations" detail="Tenant scoped plugins" />
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Plugin</th>
              <th>Tenant</th>
              <th>Version</th>
              <th>Priority</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {snapshot.installations.map((installation) => (
              <tr key={installation.id}>
                <td>{installation.pluginKey}</td>
                <td>{installation.tenantId}</td>
                <td>{installation.version}</td>
                <td>{installation.priority}</td>
                <td>
                  <StatusPill status={installation.statusText} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VersionsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
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
    </section>
  );
}

function ApprovalsPanel({
  snapshot,
  canDecide
}: {
  snapshot: DashboardSnapshot;
  canDecide: boolean;
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
    </section>
  );
}

function ExecutionsPanel({ snapshot }: { snapshot: DashboardSnapshot }) {
  return (
    <section className="data-panel">
      <PanelHeader title="Executions" detail="Hook activity" />
      <ExecutionTable snapshot={snapshot} />
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
                {execution.capabilityCalls.length === 0
                  ? "none"
                  : execution.capabilityCalls.map((call) => call.name).join(", ")}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
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
