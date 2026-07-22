import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { TemplateCatalog } from "./catalog.js";

const catalog: TemplateCatalog = {
  schemaVersion: 1,
  templates: [
    {
      slug: "invoice-approval",
      displayName: "Invoice approval",
      summary: "Routes high-value invoices through an explicit approval step.",
      license: "Apache-2.0",
      provenance: "community",
      source: { repository: "https://github.com/example/invoice", revision: "a".repeat(40) },
      sdk: { range: "^1.2.0", lastTestedVersion: "1.4.0" },
      hook: { name: "invoice.created", type: "event" },
      capabilities: ["approvals.request"],
      egress: { mode: "deny" },
      configKeys: ["APPROVAL_THRESHOLD"],
      review: { decision: "approve" }
    },
    {
      slug: "ticket-normalizer",
      displayName: "Ticket normalizer",
      summary: "Normalizes support ticket priority without external access.",
      license: "Apache-2.0",
      provenance: "simulation",
      source: { repository: "https://github.com/example/ticket", revision: "b".repeat(40) },
      sdk: { range: "^1.0.0", lastTestedVersion: "1.3.0" },
      hook: { name: "ticket.created", type: "transform" },
      capabilities: [],
      egress: { mode: "deny" },
      configKeys: [],
      review: { decision: "approve" }
    }
  ]
};

describe("Template gallery", () => {
  it("renders compatibility and review facts from the public catalog", () => {
    render(<App catalog={catalog} />);

    const invoice = screen.getByRole("article", { name: "Invoice approval" });
    expect(within(invoice).getByText("^1.2.0")).toBeInTheDocument();
    expect(within(invoice).getByText("1.4.0")).toBeInTheDocument();
    expect(within(invoice).getByText("approvals.request")).toBeInTheDocument();
    expect(within(invoice).getByText("No outbound egress")).toBeInTheDocument();
    expect(within(invoice).getByText("Reviewed: approved")).toBeInTheDocument();
    const source = within(invoice).getByRole("link", {
      name: "View reviewed source for Invoice approval"
    });
    expect(source).toHaveAttribute(
      "href",
      `https://github.com/example/invoice/tree/${"a".repeat(40)}`
    );
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(within(invoice).getByText("aaaaaaaaaaaa")).toBeInTheDocument();
  });

  it("searches names, summaries, tags, hooks, and capabilities", () => {
    render(<App catalog={catalog} />);
    const search = screen.getByRole("searchbox", { name: "Search templates" });

    for (const query of [
      "invoice",
      "high-value",
      "community",
      "invoice.created",
      "approvals.request"
    ]) {
      fireEvent.change(search, { target: { value: query } });
      expect(screen.getByRole("article", { name: "Invoice approval" })).toBeInTheDocument();
      expect(screen.queryByRole("article", { name: "Ticket normalizer" })).not.toBeInTheDocument();
    }
  });

  it("combines tag and capability filters without changing catalog order", () => {
    render(<App catalog={catalog} />);

    fireEvent.change(screen.getByLabelText("Tag"), { target: { value: "event" } });
    fireEvent.change(screen.getByLabelText("Capability"), {
      target: { value: "approvals.request" }
    });

    const articles = screen.getAllByRole("article");
    expect(articles).toHaveLength(1);
    expect(articles[0]).toHaveAccessibleName("Invoice approval");
    expect(screen.getByText("1 template found")).toBeInTheDocument();
  });

  it("shows an explicit empty state and resets every filter", () => {
    render(<App catalog={catalog} />);

    fireEvent.change(screen.getByRole("searchbox", { name: "Search templates" }), {
      target: { value: "does-not-exist" }
    });
    expect(screen.getByText("No templates match these filters.")).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Reset and show all templates" }));
    expect(screen.getAllByRole("article")).toHaveLength(2);
    expect(screen.getByText("2 templates found")).toBeInTheDocument();
  });
});
