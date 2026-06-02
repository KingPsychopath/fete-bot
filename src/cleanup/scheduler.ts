import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import { getDebugRedirectSwitchState } from "../debugRedirectSwitch.js";
import { getUserAliases } from "../db.js";
import { expandKnownAliases } from "../lidMap.js";
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

type CleanupDmSendAcceptedEvent = {
  campaignId: string;
  userId: string;
  targetJid: string;
  messageId: string;
  remoteJid: string | null | undefined;
};

type CleanupSchedulerHooks = {
  onDmSendAccepted?: (event: CleanupDmSendAcceptedEvent) => void;
};

let cleanupSchedulerTimer: ReturnType<typeof setInterval> | null = null;
let cleanupBatchInFlight = false;
let activeCleanupConfig: Config | null = null;
let activeCleanupHooks: CleanupSchedulerHooks = {};

const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

const isUserChatJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
const isLidJid = (jid: string): boolean => jid.endsWith("@lid");
const isPhoneJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net");

const getCleanupDmTargets = (member: { userId: string; primaryJid: string }): string[] => {
  const aliases = expandKnownAliases([
    member.primaryJid,
    ...getUserAliases(member.userId).map((alias) => alias.alias),
  ]).filter(isUserChatJid);

  return Array.from(new Set([
    ...aliases.filter(isLidJid),
    ...aliases.filter(isPhoneJid),
    member.primaryJid,
  ].filter(isUserChatJid)));
};

const getPhoneDigitsFromJid = (jid: string): string | null => {
  if (!isPhoneJid(jid)) {
    return null;
  }

  const digits = jid.replace(/@s\.whatsapp\.net$/iu, "").replace(/\D/gu, "");
  return digits.length > 0 ? digits : null;
};

const assertPhoneTargetExists = async (sock: WASocket, targetJid: string): Promise<void> => {
  const digits = getPhoneDigitsFromJid(targetJid);
  if (!digits) {
    return;
  }

  const onWhatsApp = (sock as Partial<Pick<WASocket, "onWhatsApp">>).onWhatsApp;
  if (typeof onWhatsApp !== "function") {
    return;
  }

  const results = await onWhatsApp(digits) ?? [];
  const exists = results.some((result) => result.exists !== false);
  log("cleanup.dm_target_onwhatsapp", {
    targetJid,
    digits,
    exists,
    resultCount: results.length,
  });

  if (!exists) {
    throw new Error("Target phone JID is not registered on WhatsApp");
  }
};

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

    const debugRedirect = getDebugRedirectSwitchState();
    if (debugRedirect.enabled) {
      warn("cleanup.dm_debug_redirect_paused", {
        campaignId: campaign.id,
        debugJid: debugRedirect.targetJid,
      });
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

    let sentCount = 0;
    let failedCount = 0;

    for (const [index, member] of members.entries()) {
      const targets = getCleanupDmTargets(member);
      let lastTargetError: unknown = null;

      try {
        log("cleanup.dm_send_attempt", {
          campaignId: campaign.id,
          userId: member.userId,
          primaryJid: member.primaryJid,
          targets,
          index: index + 1,
          count: members.length,
        });

        let sent: Awaited<ReturnType<WASocket["sendMessage"]>> | null = null;
        let targetJid: string | null = null;
        for (const [targetIndex, target] of targets.entries()) {
          try {
            log("cleanup.dm_target_attempt", {
              campaignId: campaign.id,
              userId: member.userId,
              primaryJid: member.primaryJid,
              targetJid: target,
              targetIndex: targetIndex + 1,
              targetCount: targets.length,
            });
            await assertPhoneTargetExists(sock, target);
            const targetSent = await sock.sendMessage(target, { text: campaign.dmMessage });
            const targetMessageId = targetSent?.key.id;
            if (!targetMessageId) {
              throw new Error("WhatsApp send returned without a message id");
            }
            sent = targetSent;
            targetJid = target;
            break;
          } catch (targetError) {
            lastTargetError = targetError;
            warn("cleanup.dm_target_failed", {
              campaignId: campaign.id,
              userId: member.userId,
              primaryJid: member.primaryJid,
              targetJid: target,
              error: targetError,
            });
          }
        }

        const messageId = sent?.key.id;
        if (!sent || !targetJid || !messageId) {
          throw lastTargetError ?? new Error("No usable cleanup DM target");
        }
        const sentAt = Date.now();
        markCleanupDmSent(campaign.id, member.userId, sentAt);
        recordCleanupMessage(campaign.id, targetJid, messageId, "dm", member.userId, sentAt);
        sentCount += 1;
        activeCleanupHooks.onDmSendAccepted?.({
          campaignId: campaign.id,
          userId: member.userId,
          targetJid,
          messageId,
          remoteJid: sent.key.remoteJid,
        });
        log("cleanup.dm_send_success", {
          campaignId: campaign.id,
          userId: member.userId,
          primaryJid: member.primaryJid,
          targetJid,
          messageId,
          remoteJid: sent.key.remoteJid,
        });
      } catch (sendError) {
        failedCount += 1;
        markCleanupDmFailed(campaign.id, member.userId, describeError(sendError), Date.now());
        warn("cleanup.dm_send_failed", {
          campaignId: campaign.id,
          userId: member.userId,
          primaryJid: member.primaryJid,
          targets,
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
    log("cleanup.dm_batch.finish", {
      campaignId: campaign.id,
      attempted: members.length,
      sent: sentCount,
      failed: failedCount,
      nextBatchNotBefore: Date.now() + CLEANUP_DM_RATE_LIMIT.windowMinutes * 60_000,
    });
  } catch (batchError) {
    error("cleanup.batch_failed", batchError);
  } finally {
    cleanupBatchInFlight = false;
  }
};

export const startCleanupScheduler = (
  sock: WASocket,
  config: Config,
  hooks: CleanupSchedulerHooks = {},
): void => {
  activeCleanupConfig = config;
  activeCleanupHooks = hooks;
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
  activeCleanupHooks = {};
};
