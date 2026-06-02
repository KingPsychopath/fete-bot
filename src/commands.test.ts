import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "./config.js";
import type { ResolvedUser } from "./identity.js";

let tempDir: string;
let previousDbPath: string | undefined;
let previousResetDb: string | undefined;

const config = {
  dryRun: false,
  allowedGroupJids: ["group@g.us"],
  ownerJids: ["447700900000@s.whatsapp.net"],
  muteOnStrike3: true,
  spamDuplicateMinLength: 20,
  spamFloodWarnMessageLimit: 20,
  spamFloodDeleteMessageLimit: 25,
  defaultPhoneRegion: null,
  botName: "Fete Bot",
  whatsappPairingPhoneNumber: null,
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
  ticketMarketplaceGroupJids: [],
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
  ticketExchangeWebsiteAnnouncementsEnabled: false,
  ticketExchangeWebsiteBaseUrl: "https://fete.outofofficecollective.co.uk",
  ticketExchangeWebsiteBotSecret: "",
  ticketExchangeWebsiteTargetJids: [],
  ticketExchangeWebsitePollSeconds: 120,
  ticketExchangeWebsiteBatchSize: 5,
  announcementsEnabled: false,
  announcementsTargetGroupJid: "announcements@g.us",
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

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-commands-"));
  previousDbPath = process.env.DB_PATH;
  previousResetDb = process.env.RESET_DB;
  process.env.DB_PATH = path.join(tempDir, "bot.db");
  process.env.RESET_DB = "1";
});

afterEach(async () => {
  const db = await import("./db.js");
  db.closeDb();
  if (previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previousDbPath;
  }
  if (previousResetDb === undefined) {
    delete process.env.RESET_DB;
  } else {
    process.env.RESET_DB = previousResetDb;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("authorised DM commands", () => {
  it("replies to the phone JID when a direct command arrived from a linked LID", async () => {
    const db = await import("./db.js");
    const { handleAuthorisedCommand } = await import("./commands.js");
    db.initDb();
    db.getDb()
      .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
      .run("owner", 1, "Owner", null, null);

    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "help-reply" } });
    const actor: ResolvedUser = {
      userId: "owner",
      shortId: "owner",
      createdAt: 1,
      displayName: "Owner",
      notes: null,
      mergedInto: null,
      participantJid: "111222333@lid",
      knownAliases: ["111222333@lid", "447700900000@s.whatsapp.net"],
      isNew: false,
      mergedFrom: [],
      aliases: [
        { userId: "owner", alias: "111222333@lid", aliasType: "lid", firstSeenAt: 1, lastSeenAt: 1 },
        { userId: "owner", alias: "447700900000@s.whatsapp.net", aliasType: "phone", firstSeenAt: 1, lastSeenAt: 1 },
      ],
    };

    await handleAuthorisedCommand(
      { sendMessage } as never,
      actor,
      "!help",
      null,
      config,
      new Map(),
      new Map(),
      new Set(),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "447700900000@s.whatsapp.net",
      expect.objectContaining({ text: expect.stringContaining("!help") }),
    );
  });
});
