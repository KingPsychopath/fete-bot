import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import { error, log, warn } from "../logger.js";
import {
  getOpenCleanupCampaign,
  listCleanupMembersForDmBatch,
  markCleanupBatchSent,
  markCleanupDmFailed,
  markCleanupDmSent,
  recordCleanupMessage,
  setCleanupCampaignStatus,
} from "./store.js";
import { CLEANUP_DM_RATE_LIMIT } from "./policy.js";

const CLEANUP_SCHEDULER_INTERVAL_MS = 30_000;

export const isCleanupDmHardPaused = (config: Config): boolean => !config.cleanupDmsEnabled;

let cleanupSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let cleanupBatchInFlight = false;
let activeCleanupConfig: Config | null = null;

const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

let cleanupDmWait = (delayMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

export const setCleanupDmWaitForTests = (waitForTests: typeof cleanupDmWait): void => {
  cleanupDmWait = waitForTests;
};

export const runCleanupSchedulerTick = async (sock: WASocket, config = activeCleanupConfig): Promise<void> => {
  if (!config) {
    warn("Cleanup scheduler tick skipped without config");
    return;
  }

  if (cleanupBatchInFlight) {
    return;
  }

  cleanupBatchInFlight = true;
  try {
    const campaign = getOpenCleanupCampaign();
    const nowMs = Date.now();
    if (!campaign) {
      return;
    }

    if (nowMs >= campaign.endsAt) {
      setCleanupCampaignStatus(campaign.id, "completed", nowMs);
      log("cleanup.completed", { campaignId: campaign.id });
      return;
    }

    if (campaign.status !== "active") {
      return;
    }

    if (campaign.nextBatchNotBefore && campaign.nextBatchNotBefore > nowMs) {
      return;
    }

    if (!config.cleanupDmsEnabled) {
      log("cleanup.dm_hard_paused", { campaignId: campaign.id });
      return;
    }

    const members = listCleanupMembersForDmBatch(campaign.id, CLEANUP_DM_RATE_LIMIT.messagesPerWindow);
    if (members.length === 0) {
      markCleanupBatchSent(
        campaign.id,
        nowMs + CLEANUP_DM_RATE_LIMIT.windowMinutes * 60_000,
        nowMs,
      );
      return;
    }

    log("cleanup.dm_batch.start", {
      campaignId: campaign.id,
      count: members.length,
      batchSize: CLEANUP_DM_RATE_LIMIT.messagesPerWindow,
      batchIntervalMinutes: CLEANUP_DM_RATE_LIMIT.windowMinutes,
      perMessageDelayMs: CLEANUP_DM_RATE_LIMIT.perMessageDelayMs,
    });

    for (const [index, member] of members.entries()) {
      try {
        const sent = await sock.sendMessage(member.primaryJid, { text: campaign.dmMessage });
        markCleanupDmSent(campaign.id, member.userId, Date.now());
        recordCleanupMessage(campaign.id, member.primaryJid, sent?.key.id, "dm", member.userId);
      } catch (sendError) {
        markCleanupDmFailed(campaign.id, member.userId, describeError(sendError), Date.now());
        warn("cleanup.dm_send_failed", {
          campaignId: campaign.id,
          userId: member.userId,
          jid: member.primaryJid,
          error: sendError,
        });
      }

      if (index < members.length - 1) {
        await cleanupDmWait(CLEANUP_DM_RATE_LIMIT.perMessageDelayMs);
      }
    }

    markCleanupBatchSent(
      campaign.id,
      Date.now() + CLEANUP_DM_RATE_LIMIT.windowMinutes * 60_000,
      Date.now(),
    );
  } catch (batchError) {
    error("cleanup.batch_failed", batchError);
  } finally {
    cleanupBatchInFlight = false;
  }
};

export const startCleanupScheduler = (
  sock: WASocket,
  config: Config,
): void => {
  activeCleanupConfig = config;
  stopCleanupScheduler();
  cleanupSchedulerTimer = setInterval(() => {
    void runCleanupSchedulerTick(sock);
  }, CLEANUP_SCHEDULER_INTERVAL_MS);
  void runCleanupSchedulerTick(sock);
};

export const stopCleanupScheduler = (): void => {
  if (!cleanupSchedulerTimer) {
    return;
  }

  clearInterval(cleanupSchedulerTimer);
  cleanupSchedulerTimer = null;
};
