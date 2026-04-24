import type { WASocket } from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";

import type { Config } from "../../../config.js";
import { log, warn } from "../../../logger.js";
import { claimDueSpotlights, getSpotlightSummarySince } from "./store.js";
import { sendClaimedSpotlight } from "./sender.js";

const POLL_INTERVAL_MS = 60_000;
const SUMMARY_INTERVAL_MS = 24 * 60 * 60 * 1000;

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let summaryTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;
const claimProcessId = `spotlight-${randomUUID()}`;

const subtractMinutes = (date: Date, minutes: number): string =>
  new Date(date.getTime() - minutes * 60_000).toISOString();

export const runSpotlightSchedulerTick = async (sock: WASocket, config: Config): Promise<void> => {
  if (!config.ticketSpotlightEnabled || schedulerRunning) {
    return;
  }

  schedulerRunning = true;
  try {
    const now = new Date();
    const claimed = claimDueSpotlights(
      now.toISOString(),
      subtractMinutes(now, config.ticketSpotlightClaimStaleMinutes),
      claimProcessId,
    );

    for (const pending of claimed) {
      log("spotlight.claimed", { pendingId: pending.id, sourceMsgId: pending.sourceMsgId });
      await sendClaimedSpotlight(sock, config, pending, claimProcessId, now);
    }
  } catch (schedulerError) {
    warn("Spotlight scheduler tick failed", schedulerError);
  } finally {
    schedulerRunning = false;
  }
};

export const startSpotlightScheduler = (sock: WASocket, config: Config): void => {
  if (!config.ticketSpotlightEnabled || schedulerTimer) {
    return;
  }

  schedulerTimer = setInterval(() => {
    void runSpotlightSchedulerTick(sock, config);
  }, POLL_INTERVAL_MS);
  schedulerTimer.unref();

  summaryTimer = setInterval(() => {
    const since = new Date(Date.now() - SUMMARY_INTERVAL_MS).toISOString();
    log("spotlight.summary", { since, rows: getSpotlightSummarySince(since) });
  }, SUMMARY_INTERVAL_MS);
  summaryTimer.unref();

  void runSpotlightSchedulerTick(sock, config);
};

export const stopSpotlightScheduler = (): void => {
  if (schedulerTimer) {
    clearInterval(schedulerTimer);
    schedulerTimer = null;
  }

  if (summaryTimer) {
    clearInterval(summaryTimer);
    summaryTimer = null;
  }
};
