import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;
let previousDbPath: string | undefined;
let previousResetDb: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-store-"));
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
    .run("user-1", 1, "User One", null, null);
  const store = await import("../spotlight/store.js");
  return { db, store };
};

describe("spotlight store", () => {
  it("queues, claims, prevents double-claim, and marks sent", async () => {
    const { store } = await setupDb();
    const pending = store.queueSpotlight({
      sourceGroupJid: "market@g.us",
      sourceMsgId: "msg-1",
      senderUserId: "user-1",
      senderJid: "sender@s.whatsapp.net",
      body: "Selling 2 Sunday tickets £80 each",
      classifiedIntent: "selling",
      scheduledAt: "2026-04-24T10:00:00.000Z",
    });

    expect(pending).not.toBeNull();
    expect(store.hasPendingSpotlightForSender("user-1")).toBe(true);
    const claimed = store.claimDueSpotlights("2026-04-24T10:01:00.000Z", "2026-04-24T09:56:00.000Z", "worker-1");
    expect(claimed).toHaveLength(1);
    expect(store.claimDueSpotlights("2026-04-24T10:02:00.000Z", "2026-04-24T09:57:00.000Z", "worker-2")).toHaveLength(0);
    expect(store.rescheduleClaimedSpotlight(claimed[0].id, "worker-1", "2026-04-24T10:15:00.000Z", "2026-04-24T10:02:00.000Z")).toBe(true);
    const rescheduled = store.listPendingSpotlights()[0];
    expect(rescheduled.scheduledAt).toBe("2026-04-24T10:15:00.000Z");
    expect(rescheduled.claimedAt).toBeNull();
    const reClaimed = store.claimDueSpotlights("2026-04-24T10:16:00.000Z", "2026-04-24T10:11:00.000Z", "worker-1");
    expect(reClaimed).toHaveLength(1);
    expect(store.markSpotlightSent(reClaimed[0].id, "worker-1", "2026-04-24T10:17:00.000Z")).toBe(true);
    expect(store.listRecentSpotlightOutcomes(10)[0].status).toBe("sent");
  });

  it("reclaims stale claimed rows", async () => {
    const { store } = await setupDb();
    store.queueSpotlight({
      sourceGroupJid: "market@g.us",
      sourceMsgId: "msg-1",
      senderUserId: "user-1",
      senderJid: "sender@s.whatsapp.net",
      body: "Selling 2 Sunday tickets £80 each",
      classifiedIntent: "selling",
      scheduledAt: "2026-04-24T10:00:00.000Z",
    });

    expect(store.claimDueSpotlights("2026-04-24T10:01:00.000Z", "2026-04-24T09:56:00.000Z", "worker-1")).toHaveLength(1);
    expect(store.claimDueSpotlights("2026-04-24T10:07:00.000Z", "2026-04-24T10:02:00.000Z", "worker-2")).toHaveLength(1);
  });

  it("records cooldown history and cancels source deletes", async () => {
    const { store } = await setupDb();
    const pending = store.queueSpotlight({
      sourceGroupJid: "market@g.us",
      sourceMsgId: "msg-1",
      senderUserId: "user-1",
      senderJid: "sender@s.whatsapp.net",
      body: "Selling 2 Sunday tickets £80 each",
      classifiedIntent: "selling",
      scheduledAt: "2026-04-24T10:00:00.000Z",
    });
    expect(pending).not.toBeNull();

    store.recordSpotlightHistory(pending!, "target@g.us", "2026-04-24T10:05:00.000Z");
    expect(store.hasUserSpotlightSince("user-1", "2026-04-23T10:05:00.000Z")).toBe(true);
    expect(store.hasTargetGroupSpotlightSince("target@g.us", "2026-04-24T08:05:00.000Z")).toBe(true);
    expect(store.getTargetGroupSpotlightCountSince("target@g.us", "2026-04-23T10:05:00.000Z")).toBe(1);
    expect(store.cancelSpotlightsForSource("market@g.us", "msg-1", "source_deleted")).toBe(1);
  });
});
