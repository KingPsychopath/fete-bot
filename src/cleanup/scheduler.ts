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

const CLEANUP_SCHEDULER_INTERVAL_MS = 30_000;
const CLEANUP_DM_HARD_PAUSED = true;

export const isCleanupDmHardPaused = (): boolean => CLEANUP_DM_HARD_PAUSED;

let cleanupSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let cleanupBatchInFlight = false;

const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

export const runCleanupSchedulerTick = async (sock: WASocket): Promise<void> => {
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

    if (CLEANUP_DM_HARD_PAUSED) {
      log("cleanup.dm_hard_paused", { campaignId: campaign.id });
      return;
    }

    const members = listCleanupMembersForDmBatch(campaign.id, campaign.batchSize);
    if (members.length === 0) {
      markCleanupBatchSent(
        campaign.id,
        nowMs + campaign.batchIntervalMinutes * 60_000,
        nowMs,
      );
      return;
    }

    log("cleanup.dm_batch.start", {
      campaignId: campaign.id,
      count: members.length,
      batchSize: campaign.batchSize,
    });

    for (const member of members) {
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
    }

    markCleanupBatchSent(
      campaign.id,
      Date.now() + campaign.batchIntervalMinutes * 60_000,
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
  _config: Config,
): void => {
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
