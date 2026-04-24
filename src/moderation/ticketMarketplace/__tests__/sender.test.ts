import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import {
  buildSpotlightMessage,
  formatObfuscatedPhone,
  trimSpotlightBody,
} from "../spotlight/sender.js";

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
  ticketSpotlightEnabled: true,
  ticketSpotlightBuyingEnabled: true,
  ticketSpotlightTargetJids: ["target@g.us"],
  ticketSpotlightDelayMinutes: 20,
  ticketSpotlightUserCooldownHours: 24,
  ticketSpotlightGroupCooldownMinutes: 120,
  ticketSpotlightMaxPerDay: 4,
  ticketSpotlightQuietHours: "23-8",
  ticketSpotlightTimezone: "Europe/London",
  ticketSpotlightMinLength: 15,
  ticketSpotlightBuyingMinLength: 30,
  ticketSpotlightMaxLength: 40,
  ticketSpotlightBlocklistJids: [],
  ticketSpotlightClaimStaleMinutes: 5,
} satisfies Config;

describe("spotlight sender formatting", () => {
  it("trims on a word boundary with ellipsis", () => {
    expect(trimSpotlightBody("Selling two Sunday tickets for face value please message me", 40)).toBe(
      "Selling two Sunday tickets for face…",
    );
  });

  it("builds the configured spotlight message", () => {
    expect(buildSpotlightMessage(config, "Selling 2 Sunday tickets £80 each")).toContain("From FDLM Ticket Marketplace");
    expect(buildSpotlightMessage(config, "Selling 2 Sunday tickets £80 each")).toContain("Reply in *FDLM Ticket Marketplace*");
  });

  it("obfuscates phone JIDs", () => {
    expect(formatObfuscatedPhone("447946811079@s.whatsapp.net")).toBe("+4479...1079");
    expect(formatObfuscatedPhone("abc@lid")).toBeNull();
  });
});
