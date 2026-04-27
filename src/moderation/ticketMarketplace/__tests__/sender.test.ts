import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import {
  buildSpotlightMessage,
  findSpotlightPhoneJid,
  formatObfuscatedPhone,
  trimSpotlightBody,
} from "../spotlight/sender.js";

const config = {
  dryRun: false,
  allowedGroupJids: [],
  ownerJids: [],
  muteOnStrike3: true,
  spamDuplicateMinLength: 20,
  spamFloodWarnMessageLimit: 20,
  spamFloodDeleteMessageLimit: 25,
  defaultPhoneRegion: null,
  botName: "Fete Bot",
  groupCallGuardEnabled: true,
  groupCallGuardGroupJids: [],
  groupCallGuardWarningText: "Hey {mention} - calls aren't allowed in this group. Don't do that again. 🙏🏾",
  groupCallGuardRemoveOn: 2,
  groupCallGuardWindowHours: 24,
  groupCallGuardWarningCooldownSeconds: 30,
  groupCallGuardRecentActivityTtlMinutes: 10,
  adminMentionCooldownMinutes: 10,
  ticketMarketplaceManagement: true,
  ticketMarketplaceGroupJids: ["market@g.us"],
  ticketMarketplaceGroupName: "FDLM Ticket Marketplace",
  ticketMarketplaceReplyCooldownMinutes: 30,
  ticketMarketplaceRuleReminderEnabled: true,
  ticketMarketplaceRuleReminderTime: "10:00",
  ticketMarketplaceRuleReminderTimezone: "Europe/London",
  ticketMarketplaceRuleReminderText: "",
  ticketMarketplaceRuleReminderMinActivityMessages: 3,
  ticketSpotlightEnabled: true,
  ticketSpotlightSellingEnabled: true,
  ticketSpotlightBuyingEnabled: true,
  ticketSpotlightTargetJids: ["target@g.us"],
  ticketSpotlightDelayMinutes: 20,
  ticketSpotlightSellingDelayMinutes: 20,
  ticketSpotlightBuyingDelayMinutes: 30,
  ticketSpotlightUserCooldownHours: 24,
  ticketSpotlightGroupCooldownMinutes: 60,
  ticketSpotlightBuyingMaxPerDay: 2,
  ticketSpotlightSellingMaxPerDay: 4,
  ticketSpotlightQuietHours: "23-8",
  ticketSpotlightTimezone: "Europe/London",
  ticketSpotlightMinLength: 15,
  ticketSpotlightBuyingMinLength: 30,
  ticketSpotlightSellingMinLength: 15,
  ticketSpotlightMaxLength: 40,
  ticketSpotlightBlocklistJids: [],
  ticketSpotlightClaimStaleMinutes: 5,
  ticketSpotlightReactionEmoji: "⭐",
  announcementsEnabled: false,
  announcementsTargetGroupJid: "",
  announcementsStartDate: "",
  announcementsTime: "10:00",
  announcementsIntervalDays: 3,
  announcementsTimezone: "Europe/London",
  announcementsGroupMentions: [],
} satisfies Config;

describe("spotlight sender formatting", () => {
  it("trims on a word boundary with ellipsis", () => {
    expect(trimSpotlightBody("Selling two Sunday tickets for face value please message me", 40)).toBe(
      "Selling two Sunday tickets for face…",
    );
  });

  it("builds the configured spotlight message", () => {
    expect(buildSpotlightMessage(config, "Selling 2 Sunday tickets £80 each")).toContain("Ticket available in FDLM Ticket Marketplace");
    expect(buildSpotlightMessage(config, "Selling 2 Sunday tickets £80 each")).toContain("Reply in *FDLM Ticket Marketplace*");
  });

  it("obfuscates phone JIDs", () => {
    expect(formatObfuscatedPhone("447946811079@s.whatsapp.net")).toBe("+4479...1079");
    expect(formatObfuscatedPhone("abc@lid")).toBeNull();
  });

  it("finds a known phone alias when the queued sender is a LID", () => {
    expect(
      findSpotlightPhoneJid("abc@lid", [
        {
          alias: "abc@lid",
          aliasType: "lid",
        },
        {
          alias: "447957985377@s.whatsapp.net",
          aliasType: "phone",
        },
      ]),
    ).toBe("447957985377@s.whatsapp.net");
  });
});
