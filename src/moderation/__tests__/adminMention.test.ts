import { describe, expect, it } from "vitest";

import {
  ADMIN_MENTION_REPLIES,
  AdminMentionCooldown,
  hasAdminMention,
  pickAdminMentionReply,
} from "../adminMention.js";

describe("admin mention", () => {
  it("matches standalone @admin mentions", () => {
    expect(hasAdminMention("@admin")).toBe(true);
    expect(hasAdminMention("can someone call @admin pls")).toBe(true);
    expect(hasAdminMention("POLICE @ADMIN")).toBe(true);
  });

  it("ignores partial words and non-admin mentions", () => {
    expect(hasAdminMention("@admins")).toBe(false);
    expect(hasAdminMention("email me@admin.com")).toBe(false);
    expect(hasAdminMention("@administrator")).toBe(false);
  });

  it("picks from the configured reply pool", () => {
    expect(ADMIN_MENTION_REPLIES).toContain(pickAdminMentionReply(() => 0));
    expect(ADMIN_MENTION_REPLIES).toContain(pickAdminMentionReply(() => 0.999));
  });

  it("applies cooldown per group chat", () => {
    const cooldown = new AdminMentionCooldown(1_000);

    expect(cooldown.isCoolingDown("group-1", 0)).toBe(false);
    cooldown.record("group-1", 0);

    expect(cooldown.isCoolingDown("group-1", 999)).toBe(true);
    expect(cooldown.isCoolingDown("group-2", 999)).toBe(false);
    expect(cooldown.isCoolingDown("group-1", 1_000)).toBe(false);
  });
});
