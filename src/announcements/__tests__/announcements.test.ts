import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Config } from "../../config.js";
import { buildGroupMentionContext } from "../mentions.js";
import { addDaysToLocalDate, isDue } from "../time.js";

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
  groupCallGuardWarningText: "Hey {mention} - calls aren't allowed in this group. Don't do that again. 🙏🏾",
  groupCallGuardRemoveOn: 2,
  groupCallGuardWindowHours: 24,
  groupCallGuardWarningCooldownSeconds: 30,
  groupCallGuardRecentActivityTtlMinutes: 10,
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
  announcementsEnabled: true,
  announcementsTargetGroupJid: "announcements@g.us",
  announcementsStartDate: "2026-04-24",
  announcementsTime: "10:00",
  announcementsIntervalDays: 3,
  announcementsTimezone: "Europe/London",
  announcementsGroupMentions: [{ label: "FDLM General", jid: "general@g.us" }],
} satisfies Config;

const actor = { userId: null, label: "test" };

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-announcements-"));
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

const setup = async () => {
  const db = await import("../../db.js");
  db.initDb();
  const store = await import("../store.js");
  store.ensureAnnouncementState(config, new Date("2026-04-24T08:00:00.000Z"));
  return { db, store };
};

describe("announcements", () => {
  it("manages queue state without showing full bodies in list summaries", async () => {
    const { store } = await setup();
    const first = store.addAnnouncementItem(
      "First long announcement body with enough words to identify it and enough extra detail that list output must truncate it before showing the whole thing",
      actor,
    );
    const second = store.addAnnouncementItem("Second message body", actor);

    expect(first.status).toBe("draft");
    expect(store.publishAnnouncementItem(first.id, actor)?.status).toBe("published");
    expect(store.setAnnouncementItemEnabled(first.id, false, actor)?.enabled).toBe(false);
    expect(store.setAnnouncementItemEnabled(first.id, true, actor)?.enabled).toBe(true);
    expect(store.moveAnnouncementItem(second.id, 1, actor)?.position).toBe(1);

    const { formatQueueList } = await import("../format.js");
    const list = formatQueueList(store.listAnnouncementItems());
    expect(list).toContain("Second message body");
    expect(list).not.toContain(first.body);
  });

  it("sends cycle snapshots and retries failures without picking up later edits", async () => {
    const { db, store } = await setup();
    const scheduler = await import("../scheduler.js");
    const first = store.publishAnnouncementItem(store.addAnnouncementItem("First", actor).id, actor)!;
    const second = store.publishAnnouncementItem(store.addAnnouncementItem("Second original", actor).id, actor)!;
    expect(first).toBeTruthy();
    expect(second).toBeTruthy();

    const sendMessage = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error("network down"));

    await scheduler.runAnnouncementSchedulerTick(
      { sendMessage } as never,
      config,
      new Date("2026-04-24T09:00:00.000Z"),
      { interMessageDelayMs: 0 },
    );

    store.updateAnnouncementBody(second.id, "Second edited after failure", actor);

    sendMessage.mockReset();
    sendMessage.mockResolvedValue(undefined);
    await scheduler.runAnnouncementSchedulerTick(
      { sendMessage } as never,
      config,
      new Date("2026-04-24T09:01:00.000Z"),
      { interMessageDelayMs: 0 },
    );

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(sendMessage).toHaveBeenCalledWith("announcements@g.us", { text: "Second original" });
    expect(store.getLastAnnouncementCycle()?.status).toBe("sent");
    expect(
      db.getDb().prepare("SELECT next_local_date FROM announcement_state WHERE id = 1").get(),
    ).toEqual({ next_local_date: "2026-04-27" });
  });

  it("skips and advances an empty due bundle", async () => {
    const { store } = await setup();
    const scheduler = await import("../scheduler.js");
    const sendMessage = vi.fn();

    await scheduler.runAnnouncementSchedulerTick(
      { sendMessage } as never,
      config,
      new Date("2026-04-24T09:00:00.000Z"),
      { interMessageDelayMs: 0 },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getLastAnnouncementCycle()?.status).toBe("skipped");
    expect(store.getAnnouncementState()?.nextLocalDate).toBe("2026-04-27");
  });

  it("does not send or advance in dry run, even for forced sends", async () => {
    const { store } = await setup();
    const scheduler = await import("../scheduler.js");
    const item = store.addAnnouncementItem("Dry run message", actor);
    store.publishAnnouncementItem(item.id, actor);
    const sendMessage = vi.fn();

    await scheduler.runAnnouncementSchedulerTick(
      { sendMessage } as never,
      { ...config, dryRun: true },
      new Date("2026-04-24T09:00:00.000Z"),
      { force: true, interMessageDelayMs: 0 },
    );

    expect(sendMessage).not.toHaveBeenCalled();
    expect(store.getAnnouncementState()?.nextLocalDate).toBe("2026-04-24");
  });

  it("maps configured group mentions case-insensitively", () => {
    expect(
      buildGroupMentionContext("Hey @fdlm general", [{ label: "FDLM General", jid: "general@g.us" }]),
    ).toEqual({ groupMentions: [{ groupJid: "general@g.us", groupSubject: "FDLM General" }] });
  });

  it("uses local wall-clock comparisons and calendar-day addition", () => {
    expect(addDaysToLocalDate("2026-03-28", 3)).toBe("2026-03-31");
    expect(
      isDue(
        { date: "2026-03-29", time: "10:00", timezone: "Europe/London" },
        new Date("2026-03-29T09:00:00.000Z"),
      ),
    ).toBe(true);
  });

  it("warns when the announcements target is admin-only and the bot is not admin", async () => {
    await setup();
    const { runStartupHealthCheck } = await import("../../healthCheck.js");
    const sock = {
      user: { id: "bot@s.whatsapp.net" },
      sendMessage: vi.fn(),
    };
    const groups = new Map([
      [
        "other@g.us",
        {
          id: "other@g.us",
          subject: "Other",
          owner: undefined,
          participants: [{ id: "bot@s.whatsapp.net", admin: "admin" }],
        },
      ],
      [
        "announcements@g.us",
        {
          id: "announcements@g.us",
          subject: "Announcements",
          owner: undefined,
          announce: true,
          participants: [{ id: "bot@s.whatsapp.net" }],
        },
      ],
    ]);

    const result = await runStartupHealthCheck(
      sock as never,
      { ...config, allowedGroupJids: ["other@g.us"] },
      groups as never,
    );

    expect(result.criticalFailures).toContain(
      "Announcements target appears admin-only but bot is not admin: announcements@g.us",
    );
  });
});
