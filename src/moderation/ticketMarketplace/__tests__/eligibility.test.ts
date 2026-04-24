import { describe, expect, it } from "vitest";

import type { Config } from "../../../config.js";
import { getSpotlightEligibility, hasPhoneLikeText, hasUrlLikeText, isQuietHour } from "../spotlight/eligibility.js";

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
  ticketSpotlightMaxLength: 400,
  ticketSpotlightBlocklistJids: ["blocked@s.whatsapp.net"],
  ticketSpotlightClaimStaleMinutes: 5,
} satisfies Config;

const baseInput = {
  groupJid: "market@g.us",
  senderJid: "sender@s.whatsapp.net",
  text: "Selling 2 Sunday tickets £80 each",
  intent: "selling" as const,
  hasPrice: true,
  isReply: false,
  isCommand: false,
  fromMe: false,
};

const daytime = new Date("2026-04-24T13:00:00.000Z");

describe("spotlight eligibility", () => {
  it("accepts eligible buying and priced selling marketplace posts", () => {
    expect(getSpotlightEligibility(config, baseInput, daytime)).toEqual({ eligible: true });
    expect(
      getSpotlightEligibility(
        config,
        { ...baseInput, text: "Looking for 2 Sunday tickets, willing to pay face value", intent: "buying", hasPrice: false },
        daytime,
      ),
    ).toEqual({ eligible: true });
  });

  it("rejects expected ineligible posts", () => {
    expect(getSpotlightEligibility(config, { ...baseInput, hasPrice: false }, daytime)).toEqual({
      eligible: false,
      reason: "selling_missing_price",
    });
    expect(getSpotlightEligibility(config, { ...baseInput, isReply: true }, daytime)).toEqual({ eligible: false, reason: "reply" });
    expect(getSpotlightEligibility(config, { ...baseInput, text: "Selling £80 buytix.shop" }, daytime)).toEqual({
      eligible: false,
      reason: "url",
    });
    expect(getSpotlightEligibility(config, { ...baseInput, text: "Selling £80 call +447911123456" }, daytime)).toEqual({
      eligible: false,
      reason: "phone_number",
    });
    expect(getSpotlightEligibility(config, { ...baseInput, text: "Selling £80" }, daytime)).toEqual({ eligible: false, reason: "too_short" });
    expect(
      getSpotlightEligibility(config, { ...baseInput, text: "Anyone selling?", intent: "buying", hasPrice: false }, daytime),
    ).toEqual({ eligible: false, reason: "too_short" });
    expect(getSpotlightEligibility(config, { ...baseInput, senderJid: "blocked@s.whatsapp.net" }, daytime)).toEqual({
      eligible: false,
      reason: "blocklisted",
    });
  });

  it("can disable buying spotlights independently", () => {
    expect(
      getSpotlightEligibility(
        { ...config, ticketSpotlightBuyingEnabled: false },
        { ...baseInput, text: "Looking for 2 Sunday tickets, willing to pay face value", intent: "buying", hasPrice: false },
        daytime,
      ),
    ).toEqual({ eligible: false, reason: "buying_disabled" });
  });

  it("detects quiet hours crossing midnight", () => {
    expect(isQuietHour(new Date("2026-04-24T01:00:00.000Z"), "23-8", "Europe/London")).toBe(true);
    expect(isQuietHour(new Date("2026-04-24T13:00:00.000Z"), "23-8", "Europe/London")).toBe(false);
  });

  it("detects bare domains as URLs", () => {
    expect(hasUrlLikeText("Selling this on buytix.shop")).toBe(true);
    expect(hasUrlLikeText("Selling 2 Sunday tickets £80 each")).toBe(false);
    expect(hasPhoneLikeText("Selling 2 Sunday tickets +447911123456")).toBe(true);
  });
});
