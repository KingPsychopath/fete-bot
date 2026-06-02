import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";

let tempDir: string;
let previousDbPath: string | undefined;
let previousResetDb: string | undefined;
const cleanupBackfillMessage =
  "Hey - we've added you to the OOOC Fete group chat stay list, so you're all good. No need to reply.";

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
  cleanupChannelLink: "https://whatsapp.com/channel/example",
  cleanupPublicTargetJids: [],
  logAllowedMessages: true,
  logMessageText: false,
} satisfies Config;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-cleanup-"));
  previousDbPath = process.env.DB_PATH;
  previousResetDb = process.env.RESET_DB;
  process.env.DB_PATH = path.join(tempDir, "bot.db");
  process.env.RESET_DB = "1";
});

afterEach(async () => {
  const db = await import("../../db.js");
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

const setupDb = async () => {
  const db = await import("../../db.js");
  db.initDb();
  db.getDb()
    .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
    .run("owner", 1, "Owner", null, null);
  db.getDb()
    .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
    .run("user-1", 1, "User One", null, null);
  db.getDb()
    .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
    .run("user-2", 1, "User Two", null, null);
  return db;
};

describe("cleanup campaign", () => {
  it("uses human cleanup copy that names the OOOC Fete group chats", async () => {
    const format = await import("../format.js");

    expect(format.buildCleanupPublicMessage("72 hours", null)).toContain("OOOC Fete group chats");
    expect(format.buildCleanupDmMessage("72 hours", null)).toContain("quick one from the OOOC Fete group chats");
    expect(format.buildCleanupWhitelistConfirmationMessage(null)).toContain("OOOC Fete group chats");
  });

  it("whitelists any positive signal and keeps candidates as a list only", async () => {
    await setupDb();
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: 1_000,
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
        { userId: "user-2", displayName: "User Two", primaryJid: "447700900002@s.whatsapp.net" },
      ],
    });

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(0);
    expect(store.recordCleanupSignal(campaign.id, "user-1", "group_activity", "group@g.us", "msg-1", 2_000)).toBe(true);
    expect(store.recordCleanupSignal(campaign.id, "user-1", "group_activity", "group@g.us", "msg-1", 2_500)).toBe(false);
    expect(store.recordCleanupSignal(campaign.id, "user-1", "dm_reply", "447700900001@s.whatsapp.net", "dm-1", 3_000)).toBe(true);

    const stats = store.getCleanupStats(campaign.id);
    expect(stats?.whitelisted).toBe(1);
    expect(stats?.purgeCandidates).toBe(1);
    expect(stats?.dmSkipped).toBe(1);
    expect(stats?.signals.group_activity).toBe(1);
    expect(stats?.signals.dm_reply).toBe(1);
    expect(store.listCleanupWhitelistedMembers(campaign.id, 10)[0]?.whitelistReason).toBe("group_activity");
    expect(store.listCleanupCandidateMembers(campaign.id, 10).map((member) => member.userId)).toEqual(["user-2"]);
  });

  it("reports first-time whitelist only once for acknowledgements", async () => {
    await setupDb();
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: 1_000,
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });

    expect(campaign.status).toBe("active");
    const first = store.recordCleanupSignalForOpenCampaign("user-1", "dm_reply", "447700900001@s.whatsapp.net", "dm-1", 2_000);
    expect(first.recorded).toBe(true);
    expect(first.firstWhitelist).toBe(true);
    expect(first.campaign?.channelLink).toBe(config.cleanupChannelLink);

    const duplicate = store.recordCleanupSignalForOpenCampaign("user-1", "dm_reply", "447700900001@s.whatsapp.net", "dm-1", 2_500);
    expect(duplicate.recorded).toBe(false);
    expect(duplicate.firstWhitelist).toBe(false);

    const laterSignal = store.recordCleanupSignalForOpenCampaign("user-1", "public_reply", "group@g.us", "reply-1", 3_000);
    expect(laterSignal.recorded).toBe(true);
    expect(laterSignal.firstWhitelist).toBe(false);
  });

  it("starts from !cleanup without exposing any automatic remove path", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const sendMessage = vi.fn()
      .mockResolvedValueOnce({ key: { id: "public-1" } })
      .mockResolvedValue({ key: { id: "admin-reply" } });
    const groupParticipantsUpdate = vi.fn();

    await handleCleanupCommand(
      { sendMessage, groupParticipantsUpdate } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup start 72h",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map([
        [
          "group@g.us",
          {
            id: "group@g.us",
            subject: "Fete Group",
            participants: [
              { id: "447700900001@s.whatsapp.net" },
              { id: "447700900002@s.whatsapp.net" },
            ],
          },
        ],
      ]) as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(sendMessage).toHaveBeenCalledWith("group@g.us", expect.objectContaining({
      text: expect.stringContaining("*Out of Office Collective Fete Community Cleanup*"),
    }));
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("cleanup never removes members"),
    }));
    expect(groupParticipantsUpdate).not.toHaveBeenCalled();
  });

  it("rejects disabled DM batch options", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup start 72h batch=5",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map([
        [
          "group@g.us",
          {
            id: "group@g.us",
            subject: "Fete Group",
            participants: [
              { id: "447700900001@s.whatsapp.net" },
              { id: "447700900002@s.whatsapp.net" },
            ],
          },
        ],
      ]) as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    const updated = store.getOpenCleanupCampaign();
    expect(updated).toBeNull();
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Unsupported cleanup option: batch=5"),
    }));
  });

  it("can manually whitelist a cleanup member by phone number", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
        { userId: "user-2", displayName: "User Two", primaryJid: "447700900002@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup keep +447700900002",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(store.listCleanupWhitelistedMembers(campaign.id, 10)[0]?.userId).toBe("user-2");
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: "Whitelisted User Two manually.",
    }));
  });

  it("formats manual cleanup whitelist entries as admin-readable labels", async () => {
    await setupDb();
    const format = await import("../format.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    store.recordCleanupSignal(campaign.id, "user-1", "manual", "owner@s.whatsapp.net", null);

    expect(format.formatCleanupMemberList(
      "Whitelisted members (1)",
      store.listCleanupWhitelistedMembers(campaign.id, 10),
      "Nobody is whitelisted yet.",
    )).toContain("User One (447700900001@s.whatsapp.net), manually kept, no cleanup DM needed");
  });

  it("can remove a manually whitelisted cleanup member", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    store.recordCleanupSignal(campaign.id, "user-1", "manual", "owner@s.whatsapp.net", null);
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup unkeep +447700900001",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(0);
    expect(store.listCleanupCandidateMembers(campaign.id, 10)[0]?.userId).toBe("user-1");
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: "Removed User One from the cleanup whitelist.",
    }));
  });

  it("reports when cleanup unkeep targets someone who is not whitelisted", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup unkeep +447700900001",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(0);
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: "User One is not whitelisted.",
    }));
  });

  it("hard-pauses cleanup DMs while leaving the campaign active", async () => {
    await setupDb();
    const scheduler = await import("../scheduler.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "dm-1" } });

    await scheduler.runCleanupSchedulerTick({ sendMessage } as never);

    const stats = store.getCleanupStats(campaign.id);
    expect(sendMessage).not.toHaveBeenCalled();
    expect(stats?.campaign.status).toBe("active");
    expect(stats?.dmPending).toBe(1);
    expect(stats?.dmSent).toBe(0);
  });

  it("shows the hard DM pause in cleanup status", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup status",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Cleanup DMs: *hard-paused*"),
    }));
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Next batch: hard-paused"),
    }));
  });

  it("whitelists a DM recipient from the outgoing natural backfill marker", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "react-1" } });

    await handleMessage(
      { sendMessage } as never,
      {
        key: {
          id: "marker-1",
          remoteJid: "447700900001@s.whatsapp.net",
          fromMe: true,
        },
        message: {
          conversation: cleanupBackfillMessage,
        },
      } as never,
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(store.listCleanupWhitelistedMembers(campaign.id, 10)[0]?.userId).toBe("user-1");
    expect(sendMessage).toHaveBeenCalledWith("447700900001@s.whatsapp.net", {
      react: {
        text: "✅",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
  });

  it("edits the KEEP shortcut into the natural backfill marker before reacting", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "react-1" } });

    await handleMessage(
      { sendMessage } as never,
      {
        key: {
          id: "marker-1",
          remoteJid: "447700900001@s.whatsapp.net",
          fromMe: true,
        },
        message: {
          conversation: "KEEP",
        },
      } as never,
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, "447700900001@s.whatsapp.net", {
      text: cleanupBackfillMessage,
      edit: expect.objectContaining({ id: "marker-1" }),
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "447700900001@s.whatsapp.net", {
      react: {
        text: "✅",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
  });

  it("reacts with X when the outgoing natural backfill marker was already whitelisted", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net", protected: true },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "react-1" } });

    await handleMessage(
      { sendMessage } as never,
      {
        key: {
          id: "marker-1",
          remoteJid: "447700900001@s.whatsapp.net",
          fromMe: true,
        },
        message: {
          conversation: cleanupBackfillMessage,
        },
      } as never,
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith("447700900001@s.whatsapp.net", {
      react: {
        text: "❌",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
  });

  it("allows repeated KEEP tests against an already-whitelisted protected account", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "owner", displayName: "Owner", primaryJid: "447700900000@s.whatsapp.net", protected: true },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "react-1" } });

    for (const messageId of ["marker-1", "marker-2"]) {
      await handleMessage(
        { sendMessage } as never,
        {
          key: {
            id: messageId,
            remoteJid: "447700900000@s.whatsapp.net",
            fromMe: true,
          },
          message: {
            conversation: "KEEP",
          },
        } as never,
      );
    }

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(sendMessage).toHaveBeenNthCalledWith(1, "447700900000@s.whatsapp.net", {
      text: cleanupBackfillMessage,
      edit: expect.objectContaining({ id: "marker-1" }),
    });
    expect(sendMessage).toHaveBeenNthCalledWith(2, "447700900000@s.whatsapp.net", {
      react: {
        text: "❌",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
    expect(sendMessage).toHaveBeenNthCalledWith(3, "447700900000@s.whatsapp.net", {
      text: cleanupBackfillMessage,
      edit: expect.objectContaining({ id: "marker-2" }),
    });
    expect(sendMessage).toHaveBeenNthCalledWith(4, "447700900000@s.whatsapp.net", {
      react: {
        text: "❌",
        key: expect.objectContaining({ id: "marker-2" }),
      },
    });
  });

  it("reacts with a question mark when the outgoing natural backfill marker cannot match cleanup", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "react-1" } });

    await handleMessage(
      { sendMessage } as never,
      {
        key: {
          id: "marker-1",
          remoteJid: "447700900001@s.whatsapp.net",
          fromMe: true,
        },
        message: {
          conversation: cleanupBackfillMessage,
        },
      } as never,
    );

    expect(sendMessage).toHaveBeenCalledWith("447700900001@s.whatsapp.net", {
      react: {
        text: "❓",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
  });

  it("does not treat unauthorized direct commands as cleanup opt-ins", async () => {
    await setupDb();
    const { handleMessage } = await import("../../index.js");
    const { resolveUser } = await import("../../identity.js");
    const store = await import("../store.js");
    const resolved = await resolveUser({
      participantJid: "447700900001@s.whatsapp.net",
      phoneJid: "447700900001@s.whatsapp.net",
      pushName: "User One",
      selfJids: new Set(["bot@s.whatsapp.net"]),
    });
    expect(resolved).not.toBeNull();
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: resolved!.userId, displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "reply-1" } });

    await handleMessage(
      { sendMessage, user: { id: "bot@s.whatsapp.net" } } as never,
      {
        key: {
          id: "command-1",
          remoteJid: "447700900001@s.whatsapp.net",
          fromMe: false,
        },
        pushName: "User One",
        message: {
          conversation: "!help",
        },
      } as never,
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(0);
    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "447700900001@s.whatsapp.net",
      expect.objectContaining({
        text: expect.stringContaining("You're not authorised to use Fete Bot commands"),
      }),
      expect.objectContaining({ quoted: expect.objectContaining({ key: expect.objectContaining({ id: "command-1" }) }) }),
    );
  });

  it("can manually whitelist many cleanup members from pasted phone numbers", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    const campaign = store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
        { userId: "user-2", displayName: "User Two", primaryJid: "447700900002@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup keepmany\n+44 7700 900001\n+44 7700 900002\n+44 7700 900999",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(2);
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Added: 2"),
    }));
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Not found: 1"),
    }));
  });

  it("suggests nearby cleanup members for keepmany numbers it cannot match", async () => {
    await setupDb();
    const { handleCleanupCommand } = await import("../commands.js");
    const store = await import("../store.js");
    store.createCleanupCampaign({
      durationMs: 72 * 60 * 60_000,
      actorUserId: "owner",
      actorLabel: "owner",
      channelLink: config.cleanupChannelLink,
      publicMessage: "public",
      dmMessage: "dm",
      batchSize: 25,
      batchIntervalMinutes: 30,
      nowMs: Date.now(),
      members: [
        { userId: "user-1", displayName: "User One", primaryJid: "447700900001@s.whatsapp.net" },
        { userId: "user-2", displayName: "User Two", primaryJid: "447700900002@s.whatsapp.net" },
      ],
    });
    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "admin-reply" } });

    await handleCleanupCommand(
      { sendMessage } as never,
      { userId: "owner", label: "owner", role: "owner" },
      "447700900000@s.whatsapp.net",
      "!cleanup keepmany\n+44 7700 900003",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    expect(store.getCleanupStats(store.getOpenCleanupCampaign()?.id ?? "")?.whitelisted).toBe(0);
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Suggestions:"),
    }));
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("User Two"),
    }));
  });
});
