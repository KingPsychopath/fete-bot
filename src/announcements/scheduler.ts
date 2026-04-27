import type { WASocket } from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";

import type { Config } from "../config.js";
import { log, warn } from "../logger.js";
import {
  advanceAnnouncementSchedule,
  completeAnnouncementCycle,
  ensureAnnouncementState,
  hasPendingCycleItems,
  listActiveAnnouncementItems,
  listPendingCycleItems,
  startAnnouncementCycle,
} from "./store.js";
import { isDue } from "./time.js";
import { sendAnnouncementCycleItems } from "./sender.js";

const POLL_INTERVAL_MS = 60_000;
const LARGE_BUNDLE_WARNING_COUNT = 10;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;
const processId = `announcements-${randomUUID()}`;

export const runAnnouncementSchedulerTick = async (
  sock: Pick<WASocket, "sendMessage">,
  config: Config,
  now = new Date(),
  options: { force?: boolean; trigger?: "scheduled" | "manual"; interMessageDelayMs?: number } = {},
): Promise<void> => {
  if (!config.announcementsEnabled || !config.announcementsTargetGroupJid || schedulerRunning) {
    return;
  }

  const state = ensureAnnouncementState(config, now);
  if (state.paused && !options.force) {
    return;
  }

  if (
    !state.activeCycleId &&
    !options.force &&
    !isDue({ date: state.nextLocalDate, time: state.nextLocalTime, timezone: state.timezone }, now)
  ) {
    return;
  }

  if (config.dryRun) {
    warn("Dry run: would send due announcements", {
      targetGroupJid: config.announcementsTargetGroupJid,
      nextLocalDate: state.nextLocalDate,
      nextLocalTime: state.nextLocalTime,
      timezone: state.timezone,
      activeItems: listActiveAnnouncementItems().length,
      forced: Boolean(options.force),
    });
    return;
  }

  schedulerRunning = true;
  try {
    const { cycle, items } = startAnnouncementCycle(
      config,
      options.trigger ?? (options.force ? "manual" : "scheduled"),
      config.announcementsGroupMentions,
      now,
    );

    log("announcement.cycle_started", {
      processId,
      cycleId: cycle.id,
      trigger: cycle.trigger,
      targetGroupJid: cycle.targetGroupJid,
      itemCount: items.length,
    });

    if (cycle.status === "skipped" || items.length === 0) {
      warn("announcement.cycle_skipped_empty", { cycleId: cycle.id });
      advanceAnnouncementSchedule(config, Boolean(options.force), now);
      return;
    }

    if (items.length > LARGE_BUNDLE_WARNING_COUNT) {
      warn("announcement.large_bundle", { cycleId: cycle.id, itemCount: items.length });
    }

    const result = await sendAnnouncementCycleItems(sock, config.announcementsTargetGroupJid, items, {
      interMessageDelayMs: options.interMessageDelayMs,
      now,
    });

    if (result.failed > 0 || hasPendingCycleItems(cycle.id)) {
      completeAnnouncementCycle(cycle.id, "failed", result.firstError ?? "Not all announcement items were sent", now);
      warn("announcement.cycle_failed", { cycleId: cycle.id, ...result });
      return;
    }

    completeAnnouncementCycle(cycle.id, "sent", null, now);
    advanceAnnouncementSchedule(config, Boolean(options.force), now);
    log("announcement.cycle_sent", { cycleId: cycle.id, sent: result.sent });
  } catch (schedulerError) {
    warn("Announcement scheduler tick failed", schedulerError);
  } finally {
    schedulerRunning = false;
  }
};

export const sendAnnouncementBundleNow = async (
  sock: Pick<WASocket, "sendMessage">,
  config: Config,
  now = new Date(),
): Promise<void> => {
  await runAnnouncementSchedulerTick(sock, config, now, {
    force: true,
    trigger: "manual",
  });
};

export const startAnnouncementScheduler = (
  sock: Pick<WASocket, "sendMessage">,
  config: Config,
): void => {
  if (!config.announcementsEnabled || schedulerTimer) {
    return;
  }

  schedulerTimer = setInterval(() => {
    void runAnnouncementSchedulerTick(sock, config);
  }, POLL_INTERVAL_MS);
  schedulerTimer.unref();

  void runAnnouncementSchedulerTick(sock, config);
};

export const stopAnnouncementScheduler = (): void => {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }
};

export const getPendingAnnouncementCycleItems = listPendingCycleItems;
