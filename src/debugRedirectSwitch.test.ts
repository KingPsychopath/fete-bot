import { describe, expect, it } from "vitest";

import { buildDebugParticipantUpdateText, buildDebugRedirectText } from "./debugRedirectSwitch.js";

describe("debug redirect formatting", () => {
  it("includes the original target for text messages", () => {
    expect(buildDebugRedirectText("group@g.us", { text: "hello" })).toBe(`DEBUG REDIRECT
Original target: group@g.us

hello`);
  });

  it("summarises non-text WhatsApp payloads", () => {
    expect(buildDebugRedirectText("group@g.us", { delete: { id: "msg-1" } })).toContain(
      "[non-text WhatsApp payload: delete]",
    );
  });

  it("summarises participant updates", () => {
    expect(buildDebugParticipantUpdateText("group@g.us", ["user@s.whatsapp.net"], "remove")).toContain(
      "[group participant update: remove]",
    );
  });
});
