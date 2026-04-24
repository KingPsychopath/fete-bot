import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { getTicketMarketplaceDecision } from "../index.js";

const config = {
  dryRun: false,
  allowedGroupJids: [],
  ownerJids: [],
  muteOnStrike3: true,
  defaultPhoneRegion: null,
  botName: "Fete Bot",
  ticketMarketplaceManagement: true,
  ticketMarketplaceGroupJids: ["market@g.us"],
  ticketMarketplaceGroupName: "FDLM Ticket Marketplace",
  ticketSpotlightEnabled: false,
  ticketSpotlightBuyingEnabled: true,
  ticketSpotlightTargetJids: [],
  ticketSpotlightDelayMinutes: 20,
  ticketSpotlightUserCooldownHours: 24,
  ticketSpotlightGroupCooldownMinutes: 120,
  ticketSpotlightMaxPerDay: 4,
  ticketSpotlightQuietHours: "23-8",
  ticketSpotlightTimezone: "Europe/London",
  ticketSpotlightMinLength: 15,
  ticketSpotlightBuyingMinLength: 30,
  ticketSpotlightMaxLength: 400,
  ticketSpotlightBlocklistJids: [],
  ticketSpotlightClaimStaleMinutes: 5,
} satisfies Config;

describe("ticket marketplace routing decisions", () => {
  it("redirects buying and selling outside the marketplace", () => {
    expect(getTicketMarketplaceDecision(config, "general@g.us", "Anyone selling?").action).toBe("redirect_buying");
    expect(getTicketMarketplaceDecision(config, "general@g.us", "Selling 2 Sunday tickets").action).toBe("redirect_selling");
  });

  it("allows buying and priced selling inside the marketplace", () => {
    expect(getTicketMarketplaceDecision(config, "market@g.us", "Anyone selling?").action).toBe("allow");
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
