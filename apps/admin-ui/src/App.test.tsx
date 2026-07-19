import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import {
  createDemoAdminApiClient,
  type AdminApiClient,
  type DashboardSnapshot
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
            hasDefault: false
          }
        ],
        capabilities: [
          {
            name: "slack.send",
            scopeKeys: ["channel"],
            configReferences: ["notifyChannel"],
            status: "granted"
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
    expect(screen.getByText(/notifyChannel/)).toBeInTheDocument();
    expect(screen.getByText(/slack\.send/)).toBeInTheDocument();
    expect(screen.getByText(/configured/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /Save|Enable|Disable/i })).not.toBeInTheDocument();
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
