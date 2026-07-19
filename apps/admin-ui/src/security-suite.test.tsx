import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { App } from "./App.js";
import { createAdminApiClient, createDemoAdminApiClient } from "./api-client.js";

describe("Admin UI security suite", () => {
  it("renders server-controlled labels as text without creating executable markup", async () => {
    const base = createDemoAdminApiClient();
    const session = await base.resolveSession({ token: "manager-token" });
    const dashboard = await base.getDashboard(session);
    const attack = '<img src=x onerror="globalThis.__xss=true">';
    const client = {
      ...base,
      getDashboard: () =>
        Promise.resolve({
          ...dashboard,
          installations: dashboard.installations.map((item, index) =>
            index === 0 ? { ...item, pluginKey: attack } : item
          )
        })
    };

    const { container } = render(<App client={client} />);
    fireEvent.change(screen.getByLabelText("Token"), { target: { value: "manager-token" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));
    fireEvent.click(await screen.findByRole("button", { name: "Installations" }));

    expect(await screen.findByText(attack)).toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
  });

  it("authorizes mutations with an explicit bearer token and no ambient cookie credentials", async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        Response.json({
          subject: "manager_1",
          role: "manager",
          appId: "app_1",
          tenantId: "tenant_1"
        })
      )
      .mockResolvedValueOnce(
        Response.json({ id: "inst_1", enabled: false, priority: 10, revision: 2 })
      );
    const client = createAdminApiClient({
      isDevelopment: false,
      demoMode: false,
      controlPlaneUrl: "https://api.example.com",
      fetcher
    });
    await client.resolveSession({ token: "secret-token" });

    await client.updateInstallationCommand({
      id: "inst_1",
      expectedRevision: 1,
      enabled: false
    });

    const init = fetcher.mock.calls[1]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
    expect(init?.credentials).toBe("omit");
    expect(init?.body).not.toContain("secret-token");
  });
});
