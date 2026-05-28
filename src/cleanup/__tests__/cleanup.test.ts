import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";

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
  announcementsEnabled: false,
  announcementsTargetGroupJid: "announcements@g.us",
  announcementsStartDate: "",
  announcementsTime: "10:00",
  announcementsIntervalDays: 3,
  announcementsTimezone: "Europe/London",
  announcementsGroupMentions: [],
  cleanupChannelLink: "https://whatsapp.com/channel/example",
  cleanupPublicTargetJids: [],
  cleanupDmBatchSize: 25,
  cleanupDmBatchIntervalMinutes: 30,
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
      "!cleanup start 72h batch=25 interval=30m",
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

  it("can throttle an active cleanup campaign without restarting it", async () => {
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
      "!cleanup throttle batch=5 interval=6h",
      config,
      new Map([["group@g.us", "Fete Group"]]),
      new Map() as never,
      new Set(["bot@s.whatsapp.net"]),
    );

    const updated = store.getOpenCleanupCampaign();
    expect(updated?.batchSize).toBe(5);
    expect(updated?.batchIntervalMinutes).toBe(360);
    expect(sendMessage).toHaveBeenCalledWith("447700900000@s.whatsapp.net", expect.objectContaining({
      text: expect.stringContaining("Next batch: 2 DMs in"),
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

  it("whitelists a DM recipient from the outgoing backfill marker", async () => {
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
          conversation: "OOOC KEEP",
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

  it("whitelists a DM recipient from the human-readable outgoing marker", async () => {
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
          conversation: "OOOC stay list noted",
        },
      } as never,
    );

    expect(store.getCleanupStats(campaign.id)?.whitelisted).toBe(1);
    expect(sendMessage).toHaveBeenCalledWith("447700900001@s.whatsapp.net", {
      react: {
        text: "✅",
        key: expect.objectContaining({ id: "marker-1" }),
      },
    });
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
