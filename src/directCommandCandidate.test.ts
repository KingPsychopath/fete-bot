import { describe, expect, it } from "vitest";

import { isDirectCommandCandidateText } from "./directCommandCandidate.js";

describe("direct command candidate text", () => {
  it("treats announcement confirmations as command-like direct text", () => {
    expect(isDirectCommandCandidateText("confirm igs8uj")).toBe(true);
    expect(isDirectCommandCandidateText("  confirm abc123  ")).toBe(true);
  });

  it("keeps normal direct chat text out of command routing", () => {
    expect(isDirectCommandCandidateText("hello")).toBe(false);
    expect(isDirectCommandCandidateText("confirm")).toBe(false);
  });
});
