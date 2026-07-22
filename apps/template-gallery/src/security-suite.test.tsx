import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./App.js";
import type { TemplateCatalog } from "./catalog.js";

const catalog: TemplateCatalog = {
  schemaVersion: 1,
  templates: [
    {
      slug: "safe-template",
      displayName: "Safe template",
      summary: "A bounded public summary.",
      license: "Apache-2.0",
      provenance: "community",
      source: { repository: "https://github.com/example/safe", revision: "c".repeat(40) },
      sdk: { range: "^1.0.0", lastTestedVersion: "1.0.0" },
      hook: { name: "safe.created", type: "event" },
      capabilities: [],
      egress: { mode: "deny" },
      configKeys: [],
      review: { decision: "approve" }
    }
  ]
};

describe("Template gallery security boundary", () => {
  it("renders only the public catalog projection with a safe external source link", () => {
    render(<App catalog={catalog} />);

    const source = screen.getByRole("link", { name: "View source for Safe template" });
    expect(source).toHaveAttribute("href", "https://github.com/example/safe");
    expect(source).toHaveAttribute("target", "_blank");
    expect(source).toHaveAttribute("rel", "noopener noreferrer");
    expect(document.body.textContent).not.toContain("reviewRecord");
    expect(document.body.textContent).not.toContain("reviewer");
    expect(document.body.textContent).not.toContain("evidenceDigest");
  });
});
