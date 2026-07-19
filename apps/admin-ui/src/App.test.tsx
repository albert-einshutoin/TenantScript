import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import {
  AdminApiError,
  createDemoAdminApiClient,
  type AdminApiClient,
  type DashboardSnapshot,
  type InstallationPermissionReview
} from "./api-client.js";

describe("Admin UI auth foundation", () => {
  it("masks the bearer token while it is entered", () => {
    render(<App client={createDemoAdminApiClient()} />);

    expect(screen.getByLabelText("Token")).toHaveAttribute("type", "password");
    expect(screen.getByLabelText("Token")).toHaveAttribute("spellcheck", "false");
    expect(screen.getByLabelText("Token")).toHaveAttribute("autocapitalize", "none");
  });

  it("fails closed instead of enabling demo tokens by default", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "manager-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await expect(screen.findByText("Control Plane not configured")).resolves.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval queue" })).not.toBeInTheDocument();
  });

  it("logs in with a manager role token and renders the protected dashboard", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "manager-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await expect(screen.findByText("ops-manager")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("signed in as manager")).toHaveTextContent("manager");
    expect(screen.getByRole("button", { name: "Approval queue" })).toBeInTheDocument();
    await expect(screen.findByText("Recent executions")).resolves.toBeInTheDocument();
  });

  it("routes between operational panels and signs out", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    await login("manager-token");
    await screen.findByText("Recent executions");

    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    expect(screen.getByRole("heading", { level: 1, name: "Installations" })).toBeInTheDocument();
    expect(screen.getByText("large-invoice-notify")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.getByRole("heading", { level: 1, name: "Versions" })).toBeInTheDocument();
    expect(screen.getByText("sha256:large-invoice-130")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    expect(screen.getByRole("heading", { level: 1, name: "Executions" })).toBeInTheDocument();
    expect(screen.getByText("webhook.outbound")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    expect(screen.getByRole("heading", { name: "Admin Console" })).toBeInTheDocument();
  });

  it("opens a read-only permission review from an installation row", async () => {
    const baseClient = createDemoAdminApiClient();
    const client: AdminApiClient = {
      ...baseClient,
      getInstallationPermissionReview: vi.fn().mockResolvedValue({
        id: "inst_large_invoice",
        pluginKey: "large-invoice-notify",
        version: "1.3.0",
        enabled: true,
        priority: 10,
        configFields: [
          {
            name: "notifyChannel",
            type: "string",
            required: true,
            configured: true,
            hasDefault: true
          }
        ],
        capabilities: [
          {
            name: "slack.send",
            scopeKeys: ["channel"],
            configReferences: ["notifyChannel"],
            status: "granted"
          },
          {
            name: "invoice.read",
            scopeKeys: ["fields"],
            configReferences: [],
            status: "missing"
          }
        ],
        egress: { mode: "deny", allowlistedHostCount: 0 }
      })
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Permission review for large-invoice-notify" })
    );

    await expect(
      screen.findByRole("heading", { name: "Permission review" })
    ).resolves.toBeInTheDocument();
    expect(screen.getByText(/notifyChannel.*default available/)).toBeInTheDocument();
    expect(screen.getByText(/slack\.send.*configured by notifyChannel/)).toBeInTheDocument();
    expect(screen.getByText(/invoice\.read.*static scope/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save|Enable|Disable/i })).not.toBeInTheDocument();
  });

  it("renders empty permission metadata and an allowlisted egress summary for viewers", async () => {
    const baseClient = createDemoAdminApiClient();
    const client: AdminApiClient = {
      ...baseClient,
      getInstallationPermissionReview: () =>
        Promise.resolve({
          id: "inst_large_invoice",
          pluginKey: "large-invoice-notify",
          version: "1.3.0",
          enabled: true,
          priority: 10,
          revision: 0,
          configFields: [],
          capabilities: [],
          egress: { mode: "allowlist", allowlistedHostCount: 2 }
        })
    };
    render(<App client={client} />);

    await login("viewer-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Permission review for large-invoice-notify" })
    );

    await expect(screen.findByText("No configuration fields")).resolves.toBeInTheDocument();
    expect(screen.getByText("No capabilities requested")).toBeInTheDocument();
    expect(screen.getByText(/2 allowlisted hosts/)).toBeInTheDocument();
  });

  it("lets a manager confirm an installation command, waits for server success, and prevents double submission", async () => {
    const baseClient = createDemoAdminApiClient();
    const updateInstallationCommand = vi.fn().mockResolvedValue({
      id: "inst_large_invoice",
      expectedRevision: 0,
      enabled: false
    });
    const client: AdminApiClient = { ...baseClient, updateInstallationCommand };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage large-invoice-notify" }));
    const priority = screen.getByLabelText("Priority");
    fireEvent.change(priority, { target: { value: "" } });
    expect(screen.getByRole("button", { name: "Review change" })).toBeDisabled();
    fireEvent.change(priority, { target: { value: "4.5" } });
    expect(screen.getByRole("button", { name: "Review change" })).toBeDisabled();
    fireEvent.change(priority, { target: { value: "9007199254740992" } });
    expect(screen.getByRole("button", { name: "Review change" })).toBeDisabled();
    fireEvent.change(priority, { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    expect(screen.getByRole("dialog", { name: "Confirm installation change" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Confirm installation change" })
    ).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    expect(screen.getByRole("button", { name: "Saving" })).toBeDisabled();

    await waitFor(() => {
      expect(updateInstallationCommand).toHaveBeenCalledTimes(1);
    });
    expect(updateInstallationCommand).toHaveBeenCalledWith({
      id: "inst_large_invoice",
      expectedRevision: 0,
      enabled: false
    });
    await expect(screen.findByText("disabled")).resolves.toBeInTheDocument();
  });

  it("builds config from schema and requires capability confirmation before installing", async () => {
    const baseClient = createDemoAdminApiClient();
    const getInstallPreview = vi.fn().mockResolvedValue({
      versionId: "version_large_invoice_1_2_2",
      pluginKey: "large-invoice-notify",
      version: "1.2.2",
      configFields: [
        { name: "enabledForInvoices", type: "boolean", required: false, hasDefault: true },
        { name: "notifyChannel", type: "string", required: true, hasDefault: false },
        { name: "threshold", type: "number", required: false, hasDefault: false }
      ],
      capabilities: [
        {
          name: "slack.send",
          scopeKeys: ["channel"],
          configReferences: ["notifyChannel"]
        }
      ],
      egress: { mode: "deny", allowlistedHostCount: 0 }
    });
    const installPlugin = vi.fn().mockResolvedValue({
      id: "installation_new",
      pluginKey: "large-invoice-notify",
      version: "1.2.2",
      enabled: true,
      priority: 20,
      revision: 0
    });
    render(<App client={{ ...baseClient, getInstallPreview, installPlugin }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Install large-invoice-notify 1.2.2" })
    );
    expect(await screen.findByRole("heading", { name: "Install plugin" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Review installation" })).toBeDisabled();

    fireEvent.change(screen.getByLabelText("notifyChannel (required)"), {
      target: { value: "C123" }
    });
    fireEvent.change(screen.getByLabelText("threshold (optional)"), {
      target: { value: "5000" }
    });
    fireEvent.click(screen.getByLabelText("Confirm slack.send"));
    fireEvent.click(screen.getByLabelText("Enable immediately"));
    fireEvent.change(screen.getByLabelText("Installation priority"), {
      target: { value: "20" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
    expect(
      screen.getByRole("dialog", { name: "Confirm plugin installation" })
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledTimes(1);
    });
    expect(installPlugin).toHaveBeenCalledWith({
      versionId: "version_large_invoice_1_2_2",
      config: { notifyChannel: "C123", threshold: 5000 },
      confirmedCapabilities: ["slack.send"],
      enabled: true,
      priority: 20
    });
    expect(screen.queryByRole("dialog", { name: "Confirm plugin installation" })).not.toBeInTheDocument();
  });

  it("does not expose install controls to viewers", async () => {
    render(<App client={createDemoAdminApiClient()} />);
    await login("viewer-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
  });

  it("does not render installation controls for viewers and keeps state unchanged after command failure", async () => {
    const baseClient = createDemoAdminApiClient();
    const updateInstallationCommand = vi
      .fn()
      .mockRejectedValue(new Error("SQL secret-config customer payload"));
    const client: AdminApiClient = { ...baseClient, updateInstallationCommand };
    render(<App client={client} />);

    await login("viewer-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    expect(screen.queryByRole("button", { name: /Manage / })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));
    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage large-invoice-notify" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await expect(screen.findByText("Installation update unavailable")).resolves.toBeInTheDocument();
    expect(screen.getAllByText("enabled").length).toBeGreaterThan(0);
    expect(screen.queryByText(/secret-config|customer payload/)).not.toBeInTheDocument();
  });

  it("refreshes the installation revision after a command conflict", async () => {
    const baseClient = createDemoAdminApiClient();
    const initial = await baseClient.getDashboard({
      subject: "ops-manager",
      role: "manager",
      appId: "app_demo",
      tenantId: "tenant_demo"
    });
    const refreshed: DashboardSnapshot = {
      ...initial,
      installations: initial.installations.map((installation, index) =>
        index === 0 ? { ...installation, priority: 3, revision: 1 } : installation
      )
    };
    const getDashboard = vi
      .fn<AdminApiClient["getDashboard"]>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const updateInstallationCommand = vi
      .fn<AdminApiClient["updateInstallationCommand"]>()
      .mockRejectedValueOnce(
        new AdminApiError(409, "installation_revision_conflict", "installation changed; refresh")
      )
      .mockResolvedValueOnce({
        id: "inst_large_invoice",
        enabled: false,
        priority: 3,
        revision: 2
      });
    const client: AdminApiClient = { ...baseClient, getDashboard, updateInstallationCommand };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage large-invoice-notify" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await waitFor(() => {
      expect(getDashboard).toHaveBeenCalledTimes(2);
    });
    expect(screen.getByRole("cell", { name: "3" })).toBeInTheDocument();
    expect(screen.getByLabelText("Priority")).toHaveValue("3");

    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));
    await waitFor(() => {
      expect(updateInstallationCommand).toHaveBeenCalledTimes(2);
    });
    expect(updateInstallationCommand).toHaveBeenLastCalledWith({
      id: "inst_large_invoice",
      expectedRevision: 1,
      enabled: false
    });
  });

  it("holds a single global installation command lock across row changes until a deferred request settles", async () => {
    const baseClient = createDemoAdminApiClient();
    const deferredCommand = deferred<{
      id: string;
      enabled: boolean;
      priority: number;
      revision: number;
    }>();
    const updateInstallationCommand = vi.fn().mockReturnValue(deferredCommand.promise);
    render(<App client={{ ...baseClient, updateInstallationCommand }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage large-invoice-notify" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await waitFor(() => {
      expect(updateInstallationCommand).toHaveBeenCalledTimes(1);
    });
    expect(screen.getByRole("button", { name: "Manage payload-transformer" })).toBeDisabled();
    await act(async () => {
      deferredCommand.resolve({
        id: "inst_large_invoice",
        enabled: false,
        priority: 10,
        revision: 1
      });
      await deferredCommand.promise;
    });
    await waitFor(() => {
      expect(screen.getByRole("button", { name: "Manage payload-transformer" })).toBeEnabled();
    });
  });

  it("redacts permission-review failures", async () => {
    const baseClient = createDemoAdminApiClient();
    const client: AdminApiClient = {
      ...baseClient,
      getInstallationPermissionReview: () =>
        Promise.reject(new Error("SQL contained customer-secret"))
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Permission review for large-invoice-notify" })
    );

    await expect(screen.findByText("Permission review unavailable")).resolves.toBeInTheDocument();
    expect(screen.queryByText(/customer-secret/)).not.toBeInTheDocument();
  });

  it("keeps the latest permission review when requests resolve out of order", async () => {
    const first = deferred<InstallationPermissionReview>();
    const second = deferred<InstallationPermissionReview>();
    const baseClient = createDemoAdminApiClient();
    const client: AdminApiClient = {
      ...baseClient,
      getInstallationPermissionReview: (id) =>
        id === "inst_large_invoice" ? first.promise : second.promise
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Permission review for large-invoice-notify" })
    );
    fireEvent.click(
      screen.getByRole("button", { name: "Permission review for payload-transformer" })
    );

    await act(async () => {
      second.resolve(permissionReview("inst_payload_transformer", "payload-transformer"));
      await second.promise;
    });
    await expect(screen.findByText("payload-transformer 1.0.0")).resolves.toBeInTheDocument();

    await act(async () => {
      first.resolve(permissionReview("inst_large_invoice", "large-invoice-notify"));
      await first.promise;
    });
    expect(screen.getByText("payload-transformer 1.0.0")).toBeInTheDocument();
    expect(screen.queryByText("large-invoice-notify 1.0.0")).not.toBeInTheDocument();
  });

  it("rejects invalid tokens without showing protected navigation", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await expect(screen.findByText("Token rejected")).resolves.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval queue" })).not.toBeInTheDocument();
  });

  it("keeps approval actions disabled for viewer role sessions", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "viewer-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("support-viewer");

    fireEvent.click(screen.getByRole("button", { name: "Approval queue" }));

    await waitFor(() => expect(screen.getByRole("button", { name: "Approve" })).toBeDisabled());
    expect(screen.getByRole("button", { name: "Reject" })).toBeDisabled();
  });

  it("shows a stable error boundary when the dashboard snapshot cannot load", async () => {
    const baseClient = createDemoAdminApiClient();
    const failingClient: AdminApiClient = {
      resolveSession: baseClient.resolveSession,
      getDashboard: () => Promise.reject(new Error("offline")),
      getDashboardSection: baseClient.getDashboardSection,
      getInstallationPermissionReview: baseClient.getInstallationPermissionReview,
      updateInstallationCommand: baseClient.updateInstallationCommand,
      clearSession: baseClient.clearSession
    };
    render(<App client={failingClient} />);

    await login("manager-token");

    await expect(screen.findByText("Dashboard unavailable")).resolves.toBeInTheDocument();
  });

  it("loads and appends the next tenant-scoped section page", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const initial = await baseClient.getDashboard(session);
    const getDashboardSection = vi.fn().mockResolvedValue({
      section: "installations",
      items: [
        {
          id: "inst_next",
          pluginKey: "next-plugin",
          version: "2.0.0",
          enabled: true,
          priority: 30,
          statusText: "enabled"
        }
      ]
    });
    const client: AdminApiClient = {
      resolveSession: baseClient.resolveSession,
      getDashboard: () =>
        Promise.resolve({
          ...initial,
          cursors: { installations: "signed.cursor" }
        }),
      getDashboardSection,
      getInstallationPermissionReview: baseClient.getInstallationPermissionReview,
      updateInstallationCommand: baseClient.updateInstallationCommand,
      clearSession: vi.fn()
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more installations" }));

    await expect(screen.findByText("next-plugin")).resolves.toBeInTheDocument();
    expect(getDashboardSection).toHaveBeenCalledWith("installations", "signed.cursor");
    expect(
      screen.queryByRole("button", { name: "Load more installations" })
    ).not.toBeInTheDocument();
  });

  it("shows a stable error when a next page cannot load", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const initial = await baseClient.getDashboard(session);
    const client: AdminApiClient = {
      resolveSession: baseClient.resolveSession,
      getDashboard: () => Promise.resolve({ ...initial, cursors: { executions: "signed.cursor" } }),
      getDashboardSection: () => Promise.reject(new Error("SQL customer payload")),
      getInstallationPermissionReview: baseClient.getInstallationPermissionReview,
      updateInstallationCommand: baseClient.updateInstallationCommand,
      clearSession: baseClient.clearSession
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    fireEvent.click(await screen.findByRole("button", { name: "Load more executions" }));

    await expect(
      screen.findByText("Could not load more dashboard results")
    ).resolves.toBeInTheDocument();
    expect(screen.queryByText("SQL customer payload")).not.toBeInTheDocument();
  });

  it("renders disabled and failing operational states", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const baseSnapshot = await baseClient.getDashboard(session);
    const installation = requireFirst(baseSnapshot.installations);
    const execution = requireFirst(baseSnapshot.executions);
    const snapshot: DashboardSnapshot = {
      ...baseSnapshot,
      approvals: [],
      usage: { date: "2026-07-19", executions: 0, runtimeMs: 0 },
      installations: [
        {
          ...installation,
          enabled: false,
          statusText: "disabled"
        }
      ],
      executions: [
        {
          ...execution,
          status: "error"
        }
      ]
    };
    const client: AdminApiClient = {
      resolveSession: baseClient.resolveSession,
      getDashboard: () => Promise.resolve(snapshot),
      getDashboardSection: baseClient.getDashboardSection,
      getInstallationPermissionReview: baseClient.getInstallationPermissionReview,
      updateInstallationCommand: baseClient.updateInstallationCommand,
      clearSession: baseClient.clearSession
    };
    render(<App client={client} />);

    await login("manager-token");
    await screen.findByText("Runtime ms today");
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    expect(screen.getByText("disabled")).toHaveClass("neutral");

    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    expect(screen.getByText("error")).toHaveClass("critical");
  });
});

async function login(token: string): Promise<void> {
  fireEvent.change(screen.getByLabelText("Token"), { target: { value: token } });
  fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
  await screen.findByText(token === "manager-token" ? "ops-manager" : "support-viewer");
}

function requireFirst<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) {
    throw new Error("expected fixture item");
  }
  return item;
}

function permissionReview(id: string, pluginKey: string): InstallationPermissionReview {
  return {
    id,
    pluginKey,
    version: "1.0.0",
    enabled: true,
    priority: 10,
    revision: 0,
    configFields: [],
    capabilities: [],
    egress: { mode: "deny", allowlistedHostCount: 0 }
  };
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}
