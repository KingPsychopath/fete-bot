import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../../config.js";

let tempDir: string;
let previousDbPath: string | undefined;
let previousResetDb: string | undefined;

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
  groupCallGuardWarningText: "Hey {mention} - calls aren't allowed in this group, so I ended that call. Don't do that again. 🙏🏾",
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
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-scheduler-"));
  previousDbPath = process.env.DB_PATH;
  previousResetDb = process.env.RESET_DB;
  process.env.DB_PATH = path.join(tempDir, "bot.db");
  process.env.RESET_DB = "1";
});

afterEach(async () => {
  const db = await import("../../../db.js");
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
  const db = await import("../../../db.js");
  db.initDb();
  db.getDb()
    .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
    .run("user-1", 1, "Emmanuel", null, null);
  db.getDb()
    .prepare("INSERT INTO users (id, created_at, display_name, notes, merged_into) VALUES (?, ?, ?, ?, ?)")
    .run("user-2", 1, "Other User", null, null);
  const store = await import("../spotlight/store.js");
  return { db, store };
};

describe("spotlight scheduler", () => {
  it("claims due queued spotlights, sends them, records history, and clears pending queue", async () => {
    const { db, store } = await setupDb();
    const { runSpotlightSchedulerTick } = await import("../spotlight/scheduler.js");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sock = { sendMessage };

    store.queueSpotlight({
      sourceGroupJid: "market@g.us",
      sourceMsgId: "msg-1",
      senderUserId: "user-1",
      senderJid: "447946811079@s.whatsapp.net",
      body: "Selling 3 Friday sixton tickets €30 each",
      classifiedIntent: "selling",
      scheduledAt: "2026-04-24T10:00:00.000Z",
    });

    await runSpotlightSchedulerTick(
      sock as never,
      config,
      () => ["target@g.us"],
      new Date("2026-04-24T13:00:00.000Z"),
    );

    expect(sendMessage).toHaveBeenCalledWith(
      "target@g.us",
      expect.objectContaining({
        text: expect.stringContaining("Emmanuel (+4479...1079):"),
      }),
    );
    expect(store.listPendingSpotlights()).toHaveLength(0);
    expect(
      db.getDb()
        .prepare("SELECT COUNT(*) AS count FROM spotlight_history WHERE target_group_jid = ?")
        .get("target@g.us"),
    ).toEqual({ count: 1 });
  });

  it("defers instead of cancelling when every target group is cooling down", async () => {
    const { db, store } = await setupDb();
    const { runSpotlightSchedulerTick } = await import("../spotlight/scheduler.js");
    const sendMessage = vi.fn().mockResolvedValue(undefined);
    const sock = { sendMessage };

    db.getDb()
      .prepare(`
        INSERT INTO spotlight_history (
          id,
          sender_user_id,
          sender_jid,
          source_group_jid,
          source_msg_id,
          target_group_jid,
          sent_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .run("hist-1", "user-2", "other@s.whatsapp.net", "market@g.us", "old-msg", "target@g.us", "2026-04-24T12:30:00.000Z");

    store.queueSpotlight({
      sourceGroupJid: "market@g.us",
      sourceMsgId: "msg-1",
      senderUserId: "user-1",
      senderJid: "447946811079@s.whatsapp.net",
      body: "Selling 3 Friday sixton tickets €30 each",
      classifiedIntent: "selling",
      scheduledAt: "2026-04-24T13:00:00.000Z",
    });

    await runSpotlightSchedulerTick(
      sock as never,
      config,
      () => ["target@g.us"],
      new Date("2026-04-24T13:00:00.000Z"),
    );

    expect(sendMessage).not.toHaveBeenCalled();
    const pending = store.listPendingSpotlights();
    expect(pending).toHaveLength(1);
    expect(pending[0].status).toBe("pending");
    expect(pending[0].claimedAt).toBeNull();
    expect(pending[0].scheduledAt).toBe("2026-04-24T13:15:00.000Z");
  });
});
