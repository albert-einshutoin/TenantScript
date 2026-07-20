import { describe, expect, it, vi } from "vitest";
import {
  createCapabilityBroker,
  createGitHubIssueCreateProvider,
  ProviderCredentialRejectedError
} from "../src/index.js";

describe("GitHub issue provider", () => {
  it("injects the candidate token only into the transport and returns a closed result", async () => {
    const createIssue = vi.fn().mockResolvedValue({
      number: 17,
      url: "https://github.com/tenantscript/core/issues/17"
    });
    const provider = createGitHubIssueCreateProvider({
      resolveTokens: () => ({
        candidate: { id: "github-v2", value: "candidate-secret" },
        active: { id: "github-v1", value: "active-secret" }
      }),
      createIssue
    });

    await expect(
      provider({ repository: "tenantscript/core", title: "Bug", body: "Details" })
    ).resolves.toEqual({
      number: 17,
      url: "https://github.com/tenantscript/core/issues/17"
    });
    expect(createIssue).toHaveBeenCalledWith({
      token: "candidate-secret",
      repository: "tenantscript/core",
      title: "Bug",
      body: "Details"
    });
  });

  it("falls back to the active token only for explicit credential rejection", async () => {
    const createIssue = vi
      .fn()
      .mockRejectedValueOnce(new ProviderCredentialRejectedError())
      .mockResolvedValueOnce({
        number: 18,
        url: "https://github.com/tenantscript/core/issues/18"
      });
    const provider = createGitHubIssueCreateProvider({
      resolveTokens: () => ({
        candidate: { id: "github-v2", value: "candidate-secret" },
        active: { id: "github-v1", value: "active-secret" }
      }),
      createIssue
    });

    await expect(provider({ repository: "tenantscript/core", title: "Bug" })).resolves.toEqual({
      number: 18,
      url: "https://github.com/tenantscript/core/issues/18"
    });
    expect(createIssue).toHaveBeenNthCalledWith(2, {
      token: "active-secret",
      repository: "tenantscript/core",
      title: "Bug"
    });
  });

  it.each([
    [{ repository: "tenantscript/core", title: "" }, "requires repository and title"],
    [{ repository: "../core", title: "Bug" }, "repository is invalid"],
    [
      { repository: "tenantscript/core", title: "Bug", authorization: "Bearer injected" },
      "contains unsupported input fields"
    ]
  ])("rejects malformed or credential-shaped plugin input %#", (input, message) => {
    const createIssue = vi.fn();
    const provider = githubProvider(createIssue);

    expect(() => provider(input)).toThrow(message);
    expect(createIssue).not.toHaveBeenCalled();
  });

  it("rejects repository prefix collisions before provider execution", async () => {
    const provider = vi.fn();
    const broker = createCapabilityBroker({
      grants: { "github.issue.create": { repositories: ["tenantscript/core"] } },
      providers: { "github.issue.create": provider }
    });

    await expect(
      broker.call("github.issue.create", {
        repository: "tenantscript/core-private",
        title: "Boundary bypass"
      })
    ).rejects.toThrow(
      "github.issue.create repository tenantscript/core-private is outside granted scope"
    );
    expect(provider).not.toHaveBeenCalled();
  });

  it("fails closed when the transport result could expose extra data", async () => {
    const provider = createGitHubIssueCreateProvider({
      resolveTokens: () => ({
        active: { id: "github-v1", value: "active-secret" }
      }),
      createIssue: () => ({
        number: 19,
        url: "https://github.com/tenantscript/core/issues/19",
        token: "active-secret"
      })
    });

    await expect(provider({ repository: "tenantscript/core", title: "Bug" })).rejects.toThrow(
      "provider invocation failed"
    );
  });
});

function githubProvider(
  createIssue: (request: {
    token: string;
    repository: string;
    title: string;
    body?: string;
  }) => unknown
) {
  return createGitHubIssueCreateProvider({
    resolveTokens: () => ({
      active: { id: "github-v1", value: "active-secret" }
    }),
    createIssue
  });
}
