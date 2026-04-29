import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { getTicketMarketplaceDecision } from "../index.js";

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

describe("ticket marketplace routing decisions", () => {
  it("redirects buying and selling outside the marketplace", () => {
    expect(getTicketMarketplaceDecision(config, "general@g.us", "Anyone selling?").action).toBe("redirect_buying");
    expect(getTicketMarketplaceDecision(config, "general@g.us", "Selling 2 Sunday tickets").action).toBe("redirect_selling");
  });

  it("allows buying and priced selling inside the marketplace", () => {
    expect(getTicketMarketplaceDecision(config, "market@g.us", "Anyone selling?").action).toBe("allow");
    expect(
      getTicketMarketplaceDecision(
        config,
        "market@g.us",
        "if anyone is selling two sixtion tickets for saturday please lmk",
      ).action,
    ).toBe("allow");
    expect(getTicketMarketplaceDecision(config, "market@g.us", "Selling 2 Sunday tickets £80 each").action).toBe("allow");
  });

  it("requires price for seller posts inside the marketplace", () => {
    expect(getTicketMarketplaceDecision(config, "market@g.us", "Selling 2 Sunday tickets").action).toBe("require_price");
  });

  it("allows complaint and price-discussion messages outside the marketplace", () => {
    expect(
      getTicketMarketplaceDecision(
        config,
        "general@g.us",
        "These ppl tryna sell me 100€ for 2 tickets on 21st. Im not selling, Im complaining",
      ).action,
    ).toBe("allow");
    expect(getTicketMarketplaceDecision(config, "general@g.us", "People selling tickets for 100 is crazy").action).toBe(
      "allow",
    );
  });

  it("allows all when disabled", () => {
    expect(
      getTicketMarketplaceDecision(
        { ...config, ticketMarketplaceManagement: false },
        "general@g.us",
        "Anyone selling?",
      ).action,
    ).toBe("allow");
  });
});
