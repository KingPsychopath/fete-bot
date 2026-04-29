import { describe, expect, it } from "vitest";

import { formatAuditGroupLabel } from "./auditFormat.js";

describe("formatAuditGroupLabel", () => {
  it("shows the default all-group scope for successful DM moderation commands", () => {
    expect(formatAuditGroupLabel({ command: "!ban", groupJid: null, result: "success" })).toBe("all managed groups");
    expect(formatAuditGroupLabel({ command: "!kick", groupJid: null, result: "success" })).toBe("all managed groups");
  });

  it("keeps unscoped errors and info commands as n/a", () => {
    expect(formatAuditGroupLabel({ command: "!ban", groupJid: null, result: "error" })).toBe("n/a");
    expect(formatAuditGroupLabel({ command: "!whois", groupJid: null, result: "success" })).toBe("n/a");
  });

  it("prefers an explicit group JID when one was supplied", () => {
    expect(formatAuditGroupLabel({
      command: "!ban",
      groupJid: "120363408759548644@g.us",
      result: "success",
    })).toBe("120363408759548644@g.us");
  });
});
