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
  ticketSpotlightUserCooldownHours: 24,
  ticketSpotlightGroupCooldownMinutes: 120,
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
});
