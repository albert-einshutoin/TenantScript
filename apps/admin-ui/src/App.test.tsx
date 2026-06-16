import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import {
  createDemoAdminApiClient,
  type AdminApiClient,
  type DashboardSnapshot
} from "./api-client.js";

describe("Admin UI auth foundation", () => {
  it("logs in with a manager role token and renders the protected dashboard", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "manager-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await expect(screen.findByText("ops-manager")).resolves.toBeInTheDocument();
    expect(screen.getByLabelText("signed in as manager")).toHaveTextContent("manager");
    expect(screen.getByRole("button", { name: "Approval queue" })).toBeInTheDocument();
    await expect(screen.findByText("Recent executions")).resolves.toBeInTheDocument();
  });

  it("routes between operational panels and signs out", async () => {
    render(<App />);

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

  it("rejects invalid tokens without showing protected navigation", async () => {
    render(<App />);

    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "bad-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    await expect(screen.findByText("Token rejected")).resolves.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Approval queue" })).not.toBeInTheDocument();
  });

  it("keeps approval actions disabled for viewer role sessions", async () => {
    render(<App />);

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
      getDashboard: () => Promise.reject(new Error("offline"))
    };
    render(<App client={failingClient} />);

    await login("manager-token");

    await expect(screen.findByText("Dashboard unavailable")).resolves.toBeInTheDocument();
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
      usage: [],
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
          status: "error",
          error: "handler failed"
        }
      ]
    };
    const client: AdminApiClient = {
      resolveSession: baseClient.resolveSession,
      getDashboard: () => Promise.resolve(snapshot)
    };
    render(<App client={client} />);

    await login("manager-token");
    await screen.findByText("CPU ms today");
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
