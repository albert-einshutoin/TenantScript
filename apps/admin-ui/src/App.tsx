import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createUnavailableAdminApiClient,
  AdminApiError,
  type AdminApiClient,
  type AdminSession,
  type DashboardSectionPage,
  type DashboardSnapshot,
  type InstallPluginRequest,
  type InstallPreview,
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
  const [commandInFlight, setCommandInFlight] = useState(false);
  const [installPreview, setInstallPreview] = useState<InstallPreview | null>(null);
  const [installLoading, setInstallLoading] = useState(false);
  const [installError, setInstallError] = useState<string | null>(null);
  const [installInFlight, setInstallInFlight] = useState(false);
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
  installInFlight
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
      .catch(() => {
        setError("Installation update unavailable");
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
  installInFlight
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
              {canInstall ? <th>Install</th> : null}
            </tr>
          </thead>
          <tbody>
            {snapshot.pluginVersions.map((version) => (
              <tr key={version.id}>
                <td>{version.pluginKey}</td>
                <td>{version.version}</td>
                <td className="mono-cell">{version.artifactHash}</td>
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
                  </td>
                ) : null}
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
      versionId: preview.versionId,
      config: parsed.config,
      confirmedCapabilities,
      enabled,
      priority: parsedPriority
    })
      .then(() => {
        setConfirming(false);
      })
      .catch(() => {
        setSubmitError("Plugin installation unavailable");
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
