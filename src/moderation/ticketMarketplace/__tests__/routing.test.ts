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
  ticketMarketplaceManagement: true,
  ticketMarketplaceGroupJids: ["market@g.us"],
  ticketMarketplaceGroupName: "FDLM Ticket Marketplace",
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
