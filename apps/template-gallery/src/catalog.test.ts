import { describe, expect, it } from "vitest";
import { getReviewedRevisionUrl } from "./catalog.js";

describe("reviewed source links", () => {
  it("links GitHub repositories to the exact reviewed tree", () => {
    const revision = "d".repeat(40);

    expect(
      getReviewedRevisionUrl({ repository: "https://github.com/example/template/", revision })
    ).toBe(`https://github.com/example/template/tree/${revision}`);
  });

  it("strips the accepted HTTPS clone suffix before linking the reviewed tree", () => {
    const revision = "f".repeat(40);

    expect(
      getReviewedRevisionUrl({
        repository: "https://github.com/example/template.GIT/",
        revision
      })
    ).toBe(`https://github.com/example/template/tree/${revision}`);
  });

  it("does not invent a mutable or provider-specific revision URL for unknown hosts", () => {
    expect(
      getReviewedRevisionUrl({
        repository: "https://git.example.org/community/template",
        revision: "e".repeat(40)
      })
    ).toBeUndefined();
  });
});
