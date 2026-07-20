import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import {
  AdminApiError,
  createDemoAdminApiClient,
  type AdminApiClient,
  type AdminRole,
  type DashboardSnapshot,
  type InstallationPermissionReview
} from "./api-client.js";

describe("Admin UI auth foundation", () => {
  it("exposes a keyboard skip link to a focusable main landmark", () => {
    render(<App client={createDemoAdminApiClient()} />);

    expect(screen.getByRole("link", { name: "Skip to main content" })).toHaveAttribute(
      "href",
      "#main-content"
    );
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
  });

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
    expect(screen.getByLabelText("Anonymous telemetry setting")).toHaveTextContent(
      "Anonymous telemetryOff"
    );
    expect(screen.getByRole("button", { name: "Approval queue" })).toBeInTheDocument();
    await expect(screen.findByText("Recent executions")).resolves.toBeInTheDocument();
    expect(screen.getByRole("main")).toHaveAttribute("id", "main-content");
    expect(screen.getByRole("main")).toHaveAttribute("tabindex", "-1");
    const migrations = screen.getByRole("region", { name: "Schema migrations" });
    expect(within(migrations).getAllByText("invoice.created")).toHaveLength(2);
    expect(within(migrations).getAllByText("1 blocking installation")).toHaveLength(2);
    expect(within(migrations).getByText("inst_large_invoice")).toBeInTheDocument();
    expect(within(migrations).getByText("large-invoice-notify@1.3.0 · ^1.0.0")).toBeInTheDocument();
    expect(
      within(migrations).getByText("Upgrade blockers before removing 1.0.0")
    ).toBeInTheDocument();
    const operationalHealth = screen.getByRole("region", { name: "Operational health" });
    expect(within(operationalHealth).getByText("8.82%")).toBeInTheDocument();
    expect(within(operationalHealth).getByText("Budget blocks")).toBeInTheDocument();
    expect(within(operationalHealth).getAllByText("1")).toHaveLength(3);
  });

  it("shows explicit opt-in without exposing the telemetry endpoint", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const snapshot = await baseClient.getDashboard(session);
    const client: AdminApiClient = {
      ...baseClient,
      getDashboard: () =>
        Promise.resolve({
          ...snapshot,
          telemetry: { enabled: true, mode: "anonymous-aggregate", schemaVersion: 1 }
        })
    };

    render(<App client={client} />);
    await login("manager-token");

    await waitFor(() => {
      expect(screen.getByLabelText("Anonymous telemetry setting")).toHaveTextContent(
        "Anonymous telemetryOn"
      );
    });
    expect(document.body.textContent).not.toContain("telemetry.example.com");
  });

  it("renders a zero-activity operational day without warning tones", async () => {
    const baseClient = createDemoAdminApiClient();
    const client: AdminApiClient = {
      ...baseClient,
      getOperationalHealth: () =>
        Promise.resolve({
          date: "2026-07-21",
          totalExecutions: 0,
          failedExecutions: 0,
          failureRateBps: 0,
          timeoutExecutions: 0,
          egressDeniedExecutions: 0,
          budgetExceededExecutions: 0
        })
    };
    render(<App client={client} />);

    await login("manager-token");
    const operationalHealth = await screen.findByRole("region", { name: "Operational health" });
    expect(within(operationalHealth).getByText("0.00%")).toBeInTheDocument();
    expect(within(operationalHealth).getByText("Failure rate").parentElement).toHaveClass(
      "default"
    );
    expect(within(operationalHealth).getByText("Budget blocks").parentElement).toHaveClass(
      "default"
    );
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

  it("shows a tenant audit log without rendering raw state", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    await login("manager-token");
    fireEvent.click(await screen.findByRole("button", { name: "Audit log" }));

    expect(screen.getByRole("heading", { level: 1, name: "Audit log" })).toBeInTheDocument();
    expect(screen.getByText("installation.command")).toBeInTheDocument();
    expect(screen.getByRole("cell", { name: "ops-manager" })).toBeInTheDocument();
    expect(screen.getByText(/enabled: on → off/u)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("secret-config");
  });

  it("shows the empty audit state and appends a signed-cursor page", async () => {
    const baseClient = createDemoAdminApiClient();
    const nextAudit = {
      id: "audit_next",
      installationId: "inst_next",
      pluginId: "plugin_next",
      revision: 2,
      actor: "security-reviewer",
      action: "installation.rollback",
      before: { version: "2.0.0" },
      after: { version: "1.9.0" },
      createdAt: new Date("2026-07-20T00:00:00.000Z")
    };
    const getDashboardSection = vi.fn().mockResolvedValue({
      section: "auditEvents",
      items: [nextAudit]
    });
    const client: AdminApiClient = {
      ...baseClient,
      getAuditEvents: () =>
        Promise.resolve({ section: "auditEvents", items: [], nextCursor: "signed.audit.cursor" }),
      getDashboardSection
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(await screen.findByRole("button", { name: "Audit log" }));
    expect(screen.getByText("No audit events yet")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Load more audit events" }));

    expect(await screen.findByRole("cell", { name: "security-reviewer" })).toBeInTheDocument();
    expect(screen.getByText("version: 2.0.0 → 1.9.0")).toBeInTheDocument();
    expect(getDashboardSection).toHaveBeenCalledWith("auditEvents", "signed.audit.cursor");
  });

  it("keeps accumulated execution pages within a bounded DOM window", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const snapshot = await baseClient.getDashboard(session);
    const execution = requireFirst(snapshot.executions);
    const executions = Array.from({ length: 2_000 }, (_, index) => ({
      ...execution,
      id: `exec_window_${String(index).padStart(4, "0")}`
    }));
    const client: AdminApiClient = {
      ...baseClient,
      getDashboard: () => Promise.resolve({ ...snapshot, executions })
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    const firstExecutionCell = await screen.findByRole("cell", { name: "exec_window_0000" });

    expect(screen.getByRole("region", { name: "Execution results" })).toHaveAttribute(
      "tabindex",
      "0"
    );
    expect(screen.getByRole("table")).toHaveAttribute("aria-rowcount", "2001");
    expect(firstExecutionCell.closest("tr")).toHaveAttribute("aria-rowindex", "2");
    expect(screen.getAllByRole("row").length).toBeLessThanOrEqual(32);
    expect(screen.queryByRole("cell", { name: "exec_window_1999" })).not.toBeInTheDocument();
  });

  it("moves the bounded execution window with the scroll position", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const snapshot = await baseClient.getDashboard(session);
    const execution = requireFirst(snapshot.executions);
    const executions = Array.from({ length: 2_000 }, (_, index) => ({
      ...execution,
      id: `exec_scroll_${String(index).padStart(4, "0")}`
    }));
    const replacementExecutions = Array.from({ length: 20 }, (_, index) => ({
      ...execution,
      id: `exec_replacement_${String(index).padStart(2, "0")}`
    }));
    const client: AdminApiClient = {
      ...baseClient,
      getDashboard: () => Promise.resolve({ ...snapshot, executions }),
      searchExecutions: () => Promise.resolve({ items: replacementExecutions })
    };
    render(<App client={client} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    await screen.findByRole("cell", { name: "exec_scroll_0000" });
    fireEvent.scroll(screen.getByLabelText("Execution results"), {
      target: { scrollTop: 2_000 * 52 }
    });

    const finalExecutionCell = await screen.findByRole("cell", { name: "exec_scroll_1999" });
    expect(finalExecutionCell.closest("tr")).toHaveAttribute("aria-rowindex", "2001");
    expect(screen.queryByRole("cell", { name: "exec_scroll_0000" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search executions" }));

    await screen.findByRole("cell", { name: "exec_replacement_00" });
    expect(screen.getByLabelText("Execution results")).toHaveProperty("scrollTop", 0);
  });

  it("does not expose app-wide schema blockers to tenant viewers", async () => {
    render(<App client={createDemoAdminApiClient()} />);

    await login("viewer-token");

    await expect(screen.findByText("No schema migrations configured")).resolves.toBeInTheDocument();
    expect(screen.queryByText("Upgrade blockers before removing 1.0.0")).not.toBeInTheDocument();
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
    const installPlugin = vi.fn<AdminApiClient["installPlugin"]>().mockResolvedValue({
      id: "installation_new",
      versionId: "version_large_invoice_1_2_2",
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

    fireEvent.change(await screen.findByLabelText("notifyChannel (required)"), {
      target: { value: "C123" }
    });
    fireEvent.change(screen.getByLabelText("threshold (optional)"), {
      target: { value: "5000" }
    });
    fireEvent.change(screen.getByLabelText("enabledForInvoices (optional)"), {
      target: { value: "true" }
    });
    fireEvent.click(screen.getByLabelText("Confirm slack.send"));
    fireEvent.click(screen.getByLabelText("Enable immediately"));
    fireEvent.change(screen.getByLabelText("Installation priority"), {
      target: { value: "20" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
    expect(screen.getByRole("dialog", { name: "Confirm plugin installation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));

    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledTimes(1);
    });
    expect(installPlugin.mock.calls[0]?.[0]?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
    expect(installPlugin).toHaveBeenCalledWith(
      expect.objectContaining({
        versionId: "version_large_invoice_1_2_2",
        config: { enabledForInvoices: true, notifyChannel: "C123", threshold: 5000 },
        confirmedCapabilities: ["slack.send"],
        enabled: true,
        priority: 20
      })
    );
    expect(
      screen.queryByRole("dialog", { name: "Confirm plugin installation" })
    ).not.toBeInTheDocument();
  });

  it("does not expose install controls to viewers", async () => {
    render(<App client={createDemoAdminApiClient()} />);
    await login("viewer-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    expect(screen.queryByRole("button", { name: /^Install / })).not.toBeInTheDocument();
  });

  it("lets operators review capabilities and submit an approval request without direct install", async () => {
    const baseClient = createDemoAdminApiClient();
    const requestInstallation = vi.fn<AdminApiClient["requestInstallation"]>().mockResolvedValue({
      approvalId: "approval_install_1",
      state: "pending",
      pluginKey: "large-invoice-notify",
      version: "1.2.2",
      capabilities: ["slack.send"],
      expiresAt: new Date("2026-07-21T00:00:00.000Z")
    });
    const installPlugin = vi.fn<AdminApiClient["installPlugin"]>();
    const client: AdminApiClient = {
      ...baseClient,
      resolveSession: () =>
        Promise.resolve({
          subject: "operator-subject",
          role: "operator",
          appId: "app_demo",
          tenantId: "tenant_demo"
        }),
      requestInstallation,
      installPlugin
    };
    render(<App client={client} />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "operator-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    await screen.findByText("operator-subject");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Request large-invoice-notify 1.2.2" })
    );
    fireEvent.change(await screen.findByLabelText("notifyChannel (required)"), {
      target: { value: "C123" }
    });
    fireEvent.click(screen.getByLabelText("Confirm slack.send"));
    fireEvent.click(screen.getByRole("button", { name: "Review installation request" }));
    fireEvent.click(screen.getByRole("button", { name: "Submit approval request" }));

    await waitFor(() => {
      expect(requestInstallation).toHaveBeenCalledTimes(1);
    });
    expect(installPlugin).not.toHaveBeenCalled();
    expect(await screen.findByText("Approval request pending")).toBeInTheDocument();
    expect(screen.getByText("approval_install_1")).toBeInTheDocument();
  });

  it.each([
    ["admin", true],
    ["operator", false],
    ["tenant-admin", true]
  ] as const satisfies readonly (readonly [AdminRole, boolean])[])(
    "applies RBAC installation controls for %s",
    async (role, canManage) => {
      const baseClient = createDemoAdminApiClient();
      let releaseDashboard!: () => void;
      const dashboardReady = new Promise<void>((resolve) => {
        releaseDashboard = resolve;
      });
      const client: AdminApiClient = {
        ...baseClient,
        resolveSession: () =>
          Promise.resolve({
            subject: `${role}-subject`,
            role,
            appId: "app_demo",
            tenantId: "tenant_demo"
          }),
        getDashboard: async (session) => {
          await dashboardReady;
          return await baseClient.getDashboard(session);
        }
      };
      render(<App client={client} />);

      fireEvent.change(screen.getByLabelText("Token"), { target: { value: `${role}-token` } });
      fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
      await screen.findByText(`${role}-subject`);
      fireEvent.click(screen.getByRole("button", { name: "Installations" }));
      releaseDashboard();

      expect(
        await screen.findByRole("button", { name: "Permission review for large-invoice-notify" })
      ).toBeEnabled();

      if (canManage) {
        expect(screen.getByRole("button", { name: "Manage large-invoice-notify" })).toBeEnabled();
      } else {
        expect(
          screen.queryByRole("button", { name: "Manage large-invoice-notify" })
        ).not.toBeInTheDocument();
      }
    }
  );

  it("confirms the exact rollback scope, prevents duplicate submission, and shows audit evidence", async () => {
    const baseClient = createDemoAdminApiClient();
    let resolveRollback!: (value: {
      installationId: string;
      pluginKey: string;
      fromVersion: string;
      toVersion: string;
      revision: number;
      auditId: string;
      completedAt: Date;
    }) => void;
    const rollbackInstallation = vi.fn<AdminApiClient["rollbackInstallation"]>().mockReturnValue(
      new Promise((resolve) => {
        resolveRollback = resolve;
      })
    );
    render(<App client={{ ...baseClient, rollbackInstallation }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    fireEvent.click(
      await screen.findByRole("button", {
        name: "Rollback large-invoice-notify from 1.3.0 to 1.2.2"
      })
    );

    const dialog = screen.getByRole("dialog", { name: "Confirm plugin rollback" });
    expect(dialog).toHaveTextContent("tenant_acme");
    expect(dialog).toHaveTextContent("large-invoice-notify");
    expect(dialog).toHaveTextContent("1.3.0");
    expect(dialog).toHaveTextContent("1.2.2");
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    expect(screen.getByRole("button", { name: "Rolling back" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "Rolling back" }));
    expect(rollbackInstallation).toHaveBeenCalledTimes(1);
    expect(rollbackInstallation.mock.calls[0]?.[0]?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
    expect(rollbackInstallation).toHaveBeenCalledWith({
      idempotencyKey: rollbackInstallation.mock.calls[0]?.[0]?.idempotencyKey,
      installationId: "inst_large_invoice",
      targetVersionId: "version_large_invoice_1_2_2",
      expectedRevision: 0
    });

    resolveRollback({
      installationId: "inst_large_invoice",
      pluginKey: "large-invoice-notify",
      fromVersion: "1.3.0",
      toVersion: "1.2.2",
      revision: 1,
      auditId: "audit_rollback_1",
      completedAt: new Date("2026-07-19T17:00:00.000Z")
    });
    await expect(screen.findByText("Rollback completed")).resolves.toBeInTheDocument();
    expect(screen.getByText("audit_rollback_1")).toBeInTheDocument();
    expect(screen.getByText(/UI rollback duration: \d+ ms/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "View execution log" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View execution log" }));
    expect(screen.getByRole("heading", { level: 1, name: "Executions" })).toBeInTheDocument();
  });

  it("can cancel rollback and safely refreshes after a revision conflict", async () => {
    const baseClient = createDemoAdminApiClient();
    const getDashboard = vi.spyOn(baseClient, "getDashboard");
    const rollbackInstallation = vi
      .fn<AdminApiClient["rollbackInstallation"]>()
      .mockRejectedValue(
        new AdminApiError(409, "installation_revision_conflict", "installation changed; refresh")
      );
    render(<App client={{ ...baseClient, getDashboard, rollbackInstallation }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    const rollback = await screen.findByRole("button", {
      name: "Rollback large-invoice-notify from 1.3.0 to 1.2.2"
    });
    fireEvent.click(rollback);
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(
      screen.queryByRole("dialog", { name: "Confirm plugin rollback" })
    ).not.toBeInTheDocument();

    fireEvent.click(rollback);
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await expect(
      screen.findByText("Installation changed; version history refreshed")
    ).resolves.toBeInTheDocument();
    const firstKey = rollbackInstallation.mock.calls[0]?.[0]?.idempotencyKey;
    fireEvent.click(screen.getByRole("button", { name: "Confirm rollback" }));
    await waitFor(() => {
      expect(rollbackInstallation).toHaveBeenCalledTimes(2);
    });
    expect(rollbackInstallation.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
    expect(getDashboard).toHaveBeenCalledTimes(3);
  });

  it("shows version history but hides rollback actions from viewers", async () => {
    render(<App client={createDemoAdminApiClient()} />);
    await login("viewer-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));

    expect(await screen.findByText("sha256:large-invoice-122")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Rollback / })).not.toBeInTheDocument();
  });

  it("installs a plugin with no config or capabilities and keeps it disabled by default", async () => {
    const baseClient = createDemoAdminApiClient();
    const installPlugin = vi.fn<AdminApiClient["installPlugin"]>().mockResolvedValue({
      id: "installation_empty",
      versionId: "version_large_invoice_1_3_0",
      pluginKey: "no-permissions-plugin",
      version: "1.0.0",
      enabled: false,
      priority: 100,
      revision: 0
    });
    render(
      <App
        client={{
          ...baseClient,
          getInstallPreview: () =>
            Promise.resolve({
              versionId: "version_large_invoice_1_3_0",
              pluginKey: "no-permissions-plugin",
              version: "1.0.0",
              configFields: [],
              capabilities: [],
              egress: { mode: "allowlist", allowlistedHostCount: 1 }
            }),
          installPlugin
        }}
      />
    );

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    fireEvent.click(
      await screen.findByRole("button", { name: "Install large-invoice-notify 1.3.0" })
    );
    expect(await screen.findByText("No configuration required")).toBeInTheDocument();
    expect(screen.getByText("No capabilities requested")).toBeInTheDocument();
    expect(screen.getByText(/1 allowlisted hosts/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));

    await waitFor(() => {
      expect(installPlugin.mock.calls[0]?.[0]?.idempotencyKey).toMatch(/^[a-f0-9-]{36}$/u);
      expect(installPlugin).toHaveBeenCalledWith(
        expect.objectContaining({
          versionId: "version_large_invoice_1_3_0",
          config: {},
          confirmedCapabilities: [],
          enabled: false,
          priority: 100
        })
      );
    });
  });

  it("shows stable install preview and submission failures without provider details", async () => {
    const baseClient = createDemoAdminApiClient();
    const getInstallPreview = vi
      .fn()
      .mockRejectedValueOnce(new Error("manifest customer-secret"))
      .mockResolvedValueOnce({
        versionId: "version_large_invoice_1_2_2",
        pluginKey: "large-invoice-notify",
        version: "1.2.2",
        configFields: [],
        capabilities: [],
        egress: { mode: "deny", allowlistedHostCount: 0 }
      });
    const installPlugin = vi
      .fn<AdminApiClient["installPlugin"]>()
      .mockRejectedValue(
        new AdminApiError(400, "invalid_config", "provider customer-secret validation")
      );
    render(<App client={{ ...baseClient, getInstallPreview, installPlugin }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Versions" }));
    const installButton = await screen.findByRole("button", {
      name: "Install large-invoice-notify 1.2.2"
    });
    fireEvent.click(installButton);
    expect(await screen.findByText("Installation preview unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/customer-secret/)).not.toBeInTheDocument();

    fireEvent.click(installButton);
    fireEvent.change(await screen.findByLabelText("Installation priority"), {
      target: { value: "" }
    });
    expect(screen.getByRole("button", { name: "Review installation" })).toBeDisabled();
    fireEvent.change(screen.getByLabelText("Installation priority"), {
      target: { value: "100" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Review installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));

    expect(
      await screen.findByText("Configuration does not satisfy the plugin schema")
    ).toBeInTheDocument();
    expect(screen.getByText("Plugin installation unavailable")).toBeInTheDocument();
    expect(screen.queryByText(/provider customer-secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Confirm installation" }));
    await waitFor(() => {
      expect(installPlugin).toHaveBeenCalledTimes(2);
    });
    const firstKey = installPlugin.mock.calls[0]?.[0]?.idempotencyKey;
    expect(firstKey).toEqual(expect.any(String));
    expect(installPlugin.mock.calls[1]?.[0]?.idempotencyKey).toBe(firstKey);
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

  it("shows the safe server retry window without automatically retrying a limited mutation", async () => {
    const baseClient = createDemoAdminApiClient();
    const updateInstallationCommand = vi
      .fn()
      .mockRejectedValue(
        new AdminApiError(429, "admin_mutation_rate_limited", "too many admin changes", 17)
      );
    render(<App client={{ ...baseClient, updateInstallationCommand }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(await screen.findByRole("button", { name: "Manage large-invoice-notify" }));
    fireEvent.click(screen.getByRole("button", { name: "Disable installation" }));
    fireEvent.click(screen.getByRole("button", { name: "Review change" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm change" }));

    await expect(
      screen.findByText("Too many changes. Retry in 17 seconds")
    ).resolves.toBeInTheDocument();
    expect(updateInstallationCommand).toHaveBeenCalledTimes(1);
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
      auditEvents: [],
      operationalHealth: {
        ...initial.operationalHealth,
        failedExecutions: 0,
        failureRateBps: 0
      },
      cursors: {},
      installations: initial.installations.map((installation, index) =>
        index === 0 ? { ...installation, priority: 3, revision: 1 } : installation
      )
    };
    const getDashboard = vi
      .fn<AdminApiClient["getDashboard"]>()
      .mockResolvedValueOnce(initial)
      .mockResolvedValueOnce(refreshed);
    const getOperationalHealth = vi
      .fn<AdminApiClient["getOperationalHealth"]>()
      .mockResolvedValueOnce(initial.operationalHealth)
      .mockResolvedValueOnce(refreshed.operationalHealth);
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
    const client: AdminApiClient = {
      ...baseClient,
      getDashboard,
      getOperationalHealth,
      updateInstallationCommand
    };
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

    fireEvent.click(screen.getByRole("button", { name: "Overview" }));
    expect(screen.getByRole("region", { name: "Operational health" })).toHaveTextContent("0.00%");
    expect(getOperationalHealth).toHaveBeenCalledTimes(2);

    fireEvent.click(screen.getByRole("button", { name: "Audit log" }));
    expect(screen.getByText("installation.command")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    fireEvent.click(screen.getByRole("button", { name: "Manage large-invoice-notify" }));

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

  it("confirms a manager approval and shows correlated audit evidence", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const dashboardSnapshot = await baseClient.getDashboard(session);
    const initialDashboard = deferred<DashboardSnapshot>();
    const decideApproval = vi.fn().mockResolvedValue({
      approvalId: "approval_1",
      state: "approved",
      auditId: "approval_audit_1",
      decidedAt: new Date("2026-07-20T00:00:00.000Z")
    });
    render(
      <App
        client={{
          ...baseClient,
          getDashboard: () => initialDashboard.promise,
          decideApproval
        }}
      />
    );

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Approval queue" }));
    expect(screen.getByText("Loading")).toBeInTheDocument();
    initialDashboard.resolve(dashboardSnapshot);
    fireEvent.click(await screen.findByRole("button", { name: "Approve" }));

    const dialog = await screen.findByRole("dialog", { name: "Confirm approval decision" });
    expect(dialog).toHaveTextContent("tenant_acme");
    expect(dialog).toHaveTextContent("approval_1");
    expect(dialog).toHaveTextContent("approved");
    fireEvent.change(screen.getByLabelText("Decision reason"), {
      target: { value: "validated invoice" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));

    await waitFor(() => {
      expect(decideApproval).toHaveBeenCalledWith({
        approvalId: "approval_1",
        decision: "approved",
        reason: "validated invoice"
      });
    });
    expect(screen.getByText("approval_audit_1")).toBeInTheDocument();
    expect(screen.getByText("approved")).toHaveClass("ok");
  });

  it("keeps approval state pending when the audited decision fails", async () => {
    const baseClient = createDemoAdminApiClient();
    const decideApproval = vi.fn().mockRejectedValue(new Error("D1 customer secret"));
    render(<App client={{ ...baseClient, decideApproval }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Approval queue" }));
    fireEvent.click(await screen.findByRole("button", { name: "Reject" }));
    fireEvent.click(screen.getByRole("button", { name: "Confirm approval" }));

    await expect(screen.findByText("Approval decision unavailable")).resolves.toBeInTheDocument();
    expect(screen.getByText("pending")).toHaveClass("warning");
    expect(screen.queryByLabelText("Approval decision result")).not.toBeInTheDocument();
    expect(screen.queryByText("D1 customer secret")).not.toBeInTheDocument();
  });

  it("searches executions server-side and opens a value-free capability detail", async () => {
    const baseClient = createDemoAdminApiClient();
    const session = await baseClient.resolveSession({ token: "manager-token" });
    const dashboardSnapshot = await baseClient.getDashboard(session);
    const initialDashboard = deferred<DashboardSnapshot>();
    const searchExecutions = vi.fn().mockResolvedValue({
      items: [
        {
          id: "exec_filtered",
          pluginId: "plugin_large_invoice",
          hookName: "invoice.created",
          version: "1.3.0",
          status: "error",
          durationMs: 21,
          capabilityNames: ["slack.send"],
          createdAt: new Date("2026-07-19T00:00:00.000Z")
        }
      ],
      nextCursor: "next-filtered"
    });
    const getExecutionDetail = vi.fn().mockResolvedValue({
      id: "exec_filtered",
      pluginId: "plugin_large_invoice",
      hookName: "invoice.created",
      version: "1.3.0",
      status: "error",
      durationMs: 21,
      errorCode: "execution_failed",
      capabilityCalls: [{ name: "slack.send", status: "error" }],
      createdAt: new Date("2026-07-19T00:00:00.000Z")
    });
    render(
      <App
        client={{
          ...baseClient,
          getDashboard: () => initialDashboard.promise,
          searchExecutions,
          getExecutionDetail
        }}
      />
    );

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    const pluginIdInput = screen.findByLabelText("Plugin ID");
    initialDashboard.resolve(dashboardSnapshot);
    fireEvent.change(await pluginIdInput, {
      target: { value: "plugin_large_invoice" }
    });
    fireEvent.change(screen.getByLabelText("Hook"), { target: { value: "invoice.created" } });
    fireEvent.change(screen.getByLabelText("Status"), { target: { value: "error" } });
    fireEvent.click(screen.getByRole("button", { name: "Search executions" }));

    await waitFor(() => {
      expect(searchExecutions).toHaveBeenCalledWith({
        pluginId: "plugin_large_invoice",
        hookName: "invoice.created",
        status: "error"
      });
    });
    expect(screen.getByText("exec_filtered")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "View exec_filtered" }));
    await expect(screen.findByText("execution_failed")).resolves.toBeInTheDocument();
    expect(screen.getByText(/slack\.send.*error/)).toBeInTheDocument();
    expect(getExecutionDetail).toHaveBeenCalledWith("exec_filtered");
    expect(screen.queryByText(/customer payload|provider secret/)).not.toBeInTheDocument();

    searchExecutions.mockResolvedValueOnce({ items: [], nextCursor: undefined });
    fireEvent.click(screen.getByRole("button", { name: "Load more executions" }));
    await waitFor(() => {
      expect(searchExecutions).toHaveBeenLastCalledWith({
        pluginId: "plugin_large_invoice",
        hookName: "invoice.created",
        status: "error",
        cursor: "next-filtered"
      });
    });
  });

  it("shows stable execution search and detail failures without leaking diagnostics", async () => {
    const baseClient = createDemoAdminApiClient();
    const searchExecutions = vi.fn().mockRejectedValue(new Error("SQL customer payload"));
    const getExecutionDetail = vi.fn().mockRejectedValue(new Error("provider secret"));
    render(<App client={{ ...baseClient, searchExecutions, getExecutionDetail }} />);

    await login("manager-token");
    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    fireEvent.click(screen.getByRole("button", { name: "View exec_1" }));
    await expect(screen.findByText("Execution detail unavailable")).resolves.toBeInTheDocument();
    expect(screen.queryByText("provider secret")).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Search executions" }));
    await waitFor(() => {
      expect(searchExecutions).toHaveBeenCalledWith({});
    });
    await expect(screen.findByText("Execution search unavailable")).resolves.toBeInTheDocument();
    expect(screen.queryByText("SQL customer payload")).not.toBeInTheDocument();
  });

  it("shows a stable error boundary when the dashboard snapshot cannot load", async () => {
    const baseClient = createDemoAdminApiClient();
    const failingClient: AdminApiClient = {
      ...baseClient,
      getDashboard: () => Promise.reject(new Error("offline"))
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
      ...baseClient,
      getDashboard: () =>
        Promise.resolve({
          ...initial,
          cursors: { installations: "signed.cursor" }
        }),
      getDashboardSection,
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
      ...baseClient,
      getDashboard: () => Promise.resolve({ ...initial, cursors: { executions: "signed.cursor" } }),
      getDashboardSection: () => Promise.reject(new Error("SQL customer payload"))
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
      ...baseClient,
      getDashboard: () => Promise.resolve(snapshot)
    };
    render(<App client={client} />);

    await login("manager-token");
    await screen.findByText("Runtime ms today");
    expect(screen.getAllByText("0").length).toBeGreaterThan(0);

    fireEvent.click(screen.getByRole("button", { name: "Installations" }));
    expect(screen.getByText("disabled")).toHaveClass("neutral");

    fireEvent.click(screen.getByRole("button", { name: "Executions" }));
    expect(screen.getByText("error", { selector: "span" })).toHaveClass("critical");
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
