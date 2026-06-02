import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../config.js";
import type { WebsiteTicketExchangeListing } from "./client.js";

const mocks = vi.hoisted(() => ({
  fetchWebsiteTicketExchangeListings: vi.fn(),
  isWebsiteTicketExchangeListingAnnounceable: vi.fn(),
  markWebsiteTicketExchangeListingAnnounced: vi.fn(),
  getDebugRedirectSwitchState: vi.fn(),
  isQuietSwitchEnabled: vi.fn(),
}));

vi.mock("./client.js", () => ({
  fetchWebsiteTicketExchangeListings: mocks.fetchWebsiteTicketExchangeListings,
  isWebsiteTicketExchangeListingAnnounceable: mocks.isWebsiteTicketExchangeListingAnnounceable,
  markWebsiteTicketExchangeListingAnnounced: mocks.markWebsiteTicketExchangeListingAnnounced,
}));

vi.mock("../debugRedirectSwitch.js", () => ({
  getDebugRedirectSwitchState: mocks.getDebugRedirectSwitchState,
}));

vi.mock("../quietSwitch.js", () => ({
  isQuietSwitchEnabled: mocks.isQuietSwitchEnabled,
}));

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
  whatsappPairingPhoneNumber: null,
  startupOwnerAwakeEnabled: true,
  startupOwnerAwakeCooldownMinutes: 30,
  directChatAutoresponseEnabled: true,
  directChatAutoresponseCooldownDays: 365,
  directChatAutoresponseText: "Sorry, I can't respond to direct messages. Please contact one of the other admins in the chat.",
  groupCallGuardEnabled: true,
  groupCallGuardGroupJids: [],
  groupCallGuardWarningText: "No calls",
  groupCallGuardRemoveOn: 2,
  groupCallGuardWindowHours: 24,
  groupCallGuardWarningCooldownSeconds: 30,
  groupCallGuardRecentActivityTtlMinutes: 10,
  adminMentionCooldownMinutes: 5,
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
  ticketSpotlightEnabled: true,
  ticketSpotlightSellingEnabled: true,
  ticketSpotlightBuyingEnabled: false,
  ticketSpotlightTargetJids: ["target@g.us"],
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
  ticketSpotlightReactionEmoji: "*",
  ticketExchangeWebsiteAnnouncementsEnabled: true,
  ticketExchangeWebsiteBaseUrl: "https://fete.outofofficecollective.co.uk",
  ticketExchangeWebsiteBotSecret: "secret",
  ticketExchangeWebsiteTargetJids: ["target@g.us", "market@g.us"],
  ticketExchangeWebsitePollSeconds: 120,
  ticketExchangeWebsiteBatchSize: 5,
  ticketExchangeWebsiteAnnounceDelayMinutes: 5,
  ticketExchangeWebsiteSpotlightPromptCooldownDays: 7,
  announcementsEnabled: false,
  announcementsTargetGroupJid: "",
  announcementsStartDate: "",
  announcementsTime: "10:00",
  announcementsIntervalDays: 3,
  announcementsTimezone: "Europe/London",
  announcementsGroupMentions: [],
  cleanupChannelLink: null,
  cleanupPublicTargetJids: [],
  logAllowedMessages: true,
  logMessageText: false,
} satisfies Config;

const listing = {
  id: "listing_1",
  eventKey: "event_1",
  eventSlug: "sixtion",
  eventName: "SIXTION",
  listingType: "selling",
  quantityLabel: "1",
  priceLabel: "£35",
  note: "",
  expiresAt: "2026-06-02T12:00:00.000Z",
  createdAt: "2026-06-02T09:00:00.000Z",
  url: "/tickets/listing_1",
} satisfies WebsiteTicketExchangeListing;

describe("website Ticket Exchange scheduler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getDebugRedirectSwitchState.mockReturnValue({ enabled: false, targetJid: null });
    mocks.isQuietSwitchEnabled.mockReturnValue(false);
    mocks.isWebsiteTicketExchangeListingAnnounceable.mockResolvedValue(true);
    mocks.markWebsiteTicketExchangeListingAnnounced.mockResolvedValue(undefined);
  });

  it("treats listings as eligible only after the configured delay", async () => {
    const { isWebsiteTicketExchangeListingPastAnnounceDelay } = await import("./scheduler.js");
    const now = new Date("2026-06-02T09:05:00.000Z");

    expect(isWebsiteTicketExchangeListingPastAnnounceDelay("2026-06-02T09:00:00.000Z", 5, now)).toBe(true);
    expect(isWebsiteTicketExchangeListingPastAnnounceDelay("2026-06-02T09:01:00.000Z", 5, now)).toBe(false);
  });

  it("does not status-check, send, or mark too-new listings", async () => {
    const { runWebsiteTicketExchangeAnnouncementTick } = await import("./scheduler.js");
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "sent-1" } });
    mocks.fetchWebsiteTicketExchangeListings.mockResolvedValue([
      {
        ...listing,
        createdAt: new Date(Date.now() - 2 * 60 * 1000).toISOString(),
      },
    ]);

    await runWebsiteTicketExchangeAnnouncementTick({ sendMessage } as never, config);

    expect(mocks.isWebsiteTicketExchangeListingAnnounceable).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(mocks.markWebsiteTicketExchangeListingAnnounced).not.toHaveBeenCalled();
  });

  it("sends and marks listings after the delay", async () => {
    const { runWebsiteTicketExchangeAnnouncementTick } = await import("./scheduler.js");
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "sent-1" } });
    mocks.fetchWebsiteTicketExchangeListings.mockResolvedValue([
      {
        ...listing,
        createdAt: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      },
    ]);

    await runWebsiteTicketExchangeAnnouncementTick({ sendMessage } as never, config);

    expect(mocks.isWebsiteTicketExchangeListingAnnounceable).toHaveBeenCalledWith(expect.objectContaining({
      listingId: "listing_1",
    }));
    expect(sendMessage).toHaveBeenCalledTimes(2);
    expect(mocks.markWebsiteTicketExchangeListingAnnounced).toHaveBeenCalledWith(expect.objectContaining({
      listingId: "listing_1",
    }));
  });
});
