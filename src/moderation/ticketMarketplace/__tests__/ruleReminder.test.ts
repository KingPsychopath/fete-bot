import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../../config.js";

let tempDir: string;
let previousRailwayVolumeMountPath: string | undefined;

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
} satisfies Config;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-rule-reminder-"));
  previousRailwayVolumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
});

afterEach(() => {
  if (previousRailwayVolumeMountPath === undefined) {
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  } else {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = previousRailwayVolumeMountPath;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("ticket marketplace rule reminder", () => {
  it("builds the default reminder with pinned message and group description references", async () => {
    const { buildTicketMarketplaceRuleReminderMessage } = await import("../ruleReminder.js");

    expect(buildTicketMarketplaceRuleReminderMessage(config)).toContain("pinned message and group description");
    expect(buildTicketMarketplaceRuleReminderMessage(config, "Rule 1\nRule 2")).toContain("\n\nRule 1\nRule 2");
    expect(buildTicketMarketplaceRuleReminderMessage(config, "Rule 1\nRule 2")).not.toContain("Group description:");
  });

  it("sends once per marketplace group after the configured local time", async () => {
    const { recordTicketMarketplaceRuleReminderActivity, runTicketMarketplaceRuleReminderTick } = await import("../ruleReminder.js");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const groupMetadata = vi.fn().mockResolvedValue({ desc: "1. Face value only\n2. No screenshots" });
    const sock = { groupMetadata, sendMessage };

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-24T08:59:00.000Z"),
    );
    expect(sendMessage).not.toHaveBeenCalled();

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-24T09:00:00.000Z"),
    );
    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-24T15:00:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith(
      "market@g.us",
      expect.objectContaining({
        text: expect.stringContaining("\n\n1. Face value only\n2. No screenshots"),
      }),
    );

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-25T09:00:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);

    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-25T12:00:00.000Z"));

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-25T12:01:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);

    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-25T12:02:00.000Z"));
    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-25T12:03:00.000Z"));

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-25T12:04:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-26T09:00:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);

    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-26T12:00:00.000Z"));
    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-26T12:01:00.000Z"));
    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-26T12:02:00.000Z"));

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      config,
      new Date("2026-04-26T12:03:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(3);
  });

  it("allows the activity threshold to be configured", async () => {
    const { recordTicketMarketplaceRuleReminderActivity, runTicketMarketplaceRuleReminderTick } = await import("../ruleReminder.js");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const groupMetadata = vi.fn().mockResolvedValue({ desc: null });
    const sock = { groupMetadata, sendMessage };
    const oneActivityConfig = { ...config, ticketMarketplaceRuleReminderMinActivityMessages: 1 };

    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      oneActivityConfig,
      new Date("2026-04-24T09:00:00.000Z"),
    );
    recordTicketMarketplaceRuleReminderActivity("market@g.us", new Date("2026-04-25T12:00:00.000Z"));
    await runTicketMarketplaceRuleReminderTick(
      sock as never,
      oneActivityConfig,
      new Date("2026-04-25T12:01:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledTimes(2);
  });

  it("uses configured reminder text when provided", async () => {
    const { buildTicketMarketplaceRuleReminderMessage } = await import("../ruleReminder.js");

    expect(
      buildTicketMarketplaceRuleReminderMessage({
        ...config,
        ticketMarketplaceRuleReminderText: "Please read the pinned post before buying or selling.",
      }),
    ).toBe("Please read the pinned post before buying or selling.");
  });
});
