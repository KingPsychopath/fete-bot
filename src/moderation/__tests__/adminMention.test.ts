import { describe, expect, it } from "vitest";

import {
  ADMIN_MENTION_OVERUSE_REPLIES,
  ADMIN_MENTION_REPLIES,
  AdminMentionCooldown,
  hasAdminSummon,
  hasAdminMention,
  hasBotSelfMention,
  pickAdminMentionReply,
} from "../adminMention.js";

describe("admin mention", () => {
  it("matches standalone @admin mentions", () => {
    expect(hasAdminMention("@admin")).toBe(true);
    expect(hasAdminMention("@admins")).toBe(true);
    expect(hasAdminMention("can someone call @admin pls")).toBe(true);
    expect(hasAdminMention("can someone call @admins pls")).toBe(true);
    expect(hasAdminMention("POLICE @ADMIN")).toBe(true);
  });

  it("ignores partial words and non-admin mentions", () => {
    expect(hasAdminMention("email me@admin.com")).toBe(false);
    expect(hasAdminMention("@administrator")).toBe(false);
  });

  it("matches the bot's WhatsApp mention metadata", () => {
    const selfJids = new Set(["12345@s.whatsapp.net", "abc@lid"]);

    expect(hasBotSelfMention(["12345:9@s.whatsapp.net"], selfJids)).toBe(true);
    expect(hasBotSelfMention(["ABC@LID"], selfJids)).toBe(true);
    expect(hasBotSelfMention(["67890@s.whatsapp.net"], selfJids)).toBe(false);
  });

  it("treats @admin text and bot mentions as summons", () => {
    const selfJids = new Set(["12345@s.whatsapp.net"]);

    expect(hasAdminSummon("call @admin", [], selfJids)).toBe(true);
    expect(hasAdminSummon("hello bot", ["12345@s.whatsapp.net"], selfJids)).toBe(true);
    expect(hasAdminSummon("hello everyone", [], selfJids)).toBe(false);
  });

  it("picks from the configured reply pool", () => {
    expect(ADMIN_MENTION_REPLIES).toContain(pickAdminMentionReply(() => 0));
    expect(ADMIN_MENTION_REPLIES).toContain(pickAdminMentionReply(() => 0.999));
  });

  it("keeps overuse replies in the leave me alone pool", () => {
    expect(ADMIN_MENTION_OVERUSE_REPLIES).toHaveLength(4);
    expect(ADMIN_MENTION_OVERUSE_REPLIES.every((reply) => reply.startsWith("Leave me alone"))).toBe(true);
    expect(ADMIN_MENTION_OVERUSE_REPLIES).toContain("Leave me alone. You're so obsessed with me");
    expect(ADMIN_MENTION_OVERUSE_REPLIES).toContain("Leave me alone. Please go touch grass.");
    expect(ADMIN_MENTION_OVERUSE_REPLIES).toContain("Leave me alone. I'm shy.");
    expect(ADMIN_MENTION_OVERUSE_REPLIES).toContain("Leave me alone. You are overstimulating me");
  });

  it("applies cooldown per group chat", () => {
    const cooldown = new AdminMentionCooldown(1_000);

    expect(cooldown.isCoolingDown("group-1", 0)).toBe(false);
    cooldown.recordCooldown("group-1", 0);

    expect(cooldown.isCoolingDown("group-1", 999)).toBe(true);
    expect(cooldown.isCoolingDown("group-2", 999)).toBe(false);
    expect(cooldown.isCoolingDown("group-1", 1_000)).toBe(false);
  });

  it("allows one overuse reply after too many mentions per group in the cooldown window", () => {
    const cooldown = new AdminMentionCooldown(1_000);

    expect(cooldown.recordSummon("group-1", 0)).toBe(false);

    expect(cooldown.recordSummon("group-1", 100)).toBe(false);
    expect(cooldown.recordSummon("group-2", 200)).toBe(false);
    expect(cooldown.recordSummon("group-1", 300)).toBe(true);
    expect(cooldown.recordSummon("group-1", 400)).toBe(false);
    expect(cooldown.recordSummon("group-1", 1_300)).toBe(false);
    expect(cooldown.recordSummon("group-1", 1_500)).toBe(false);
    expect(cooldown.recordSummon("group-1", 1_600)).toBe(true);
  });

  it("tracks overuse with a separate threshold and time range", () => {
    const cooldown = new AdminMentionCooldown(5_000, 1_000, 2);

    expect(cooldown.recordSummon("group-1", 0)).toBe(false);
    expect(cooldown.recordSummon("group-1", 1_000)).toBe(false);
    expect(cooldown.recordSummon("group-1", 1_001)).toBe(true);
  });
});
