import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { buildTicketMarketplaceExplainText } from "../explain.js";

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
  adminMentionOveruseThreshold: 3,
  adminMentionOveruseWindowMinutes: 3,
  ticketMarketplaceManagement: true,
  ticketMarketplaceGroupJids: ["market@g.us"],
  ticketMarketplaceGroupName: "FDLM Ticket Marketplace",
  ticketMarketplaceReplyCooldownMinutes: 30,
  ticketMarketplaceRuleReminderEnabled: true,
  ticketMarketplaceRuleReminderTime: "10:00",
  ticketMarketplaceRuleReminderTimezone: "Europe/London",
  ticketMarketplaceRuleReminderText: "",
  ticketMarketplaceRuleReminderMinActivityMessages: 3,
  ticketSpotlightEnabled: false,
  ticketSpotlightSellingEnabled: true,
  ticketSpotlightBuyingEnabled: true,
  ticketSpotlightTargetJids: [],
  ticketSpotlightDelayMinutes: 15,
  ticketSpotlightSellingDelayMinutes: 15,
  ticketSpotlightBuyingDelayMinutes: 15,
  ticketSpotlightUserCooldownHours: 24,
  ticketSpotlightGroupCooldownMinutes: 60,
  ticketSpotlightBuyingMaxPerDay: 2,
  ticketSpotlightSellingMaxPerDay: 4,
  ticketSpotlightQuietHours: "23-8",
  ticketSpotlightTimezone: "Europe/London",
  ticketSpotlightMinLength: 15,
  ticketSpotlightBuyingMinLength: 30,
  ticketSpotlightSellingMinLength: 15,
  ticketSpotlightMaxLength: 400,
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
  logAllowedMessages: true,
  logMessageText: false,
} satisfies Config;

describe("ticket marketplace explanation", () => {
  it("shows the classifier and routing decision evidence", () => {
    const explanation = buildTicketMarketplaceExplainText(config, "general@g.us", "is anyone selling two tickets");

    expect(explanation).toContain("Action: review");
    expect(explanation).toContain("Reason: ticket_marketplace_review");
    expect(explanation).toContain("Intent: buying");
    expect(explanation).toContain("Confidence: medium");
    expect(explanation).toContain("Buy signals:");
  });

  it("makes false-positive exemptions visible", () => {
    const explanation = buildTicketMarketplaceExplainText(
      config,
      "general@g.us",
      "I found a place for six guests, £300 per person, dates are from June 18th to June 23rd, secure the booking, double beds",
    );

    expect(explanation).toContain("Action: allow");
    expect(explanation).toContain("Intent: none");
    expect(explanation).toContain("Confidence: low");
  });
});
