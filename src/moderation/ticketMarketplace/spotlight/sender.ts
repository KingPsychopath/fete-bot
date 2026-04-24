import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../../../config.js";
import type { SpotlightPendingRow } from "../../../db.js";
import { describeUser } from "../../../identity.js";
import { log, warn } from "../../../logger.js";
import {
  cancelClaimedSpotlight,
  getTargetGroupSpotlightCountSince,
  hasTargetGroupSpotlightSince,
  hasUserSpotlightSince,
  markSpotlightSent,
  recordSpotlightHistory,
  rescheduleClaimedSpotlight,
} from "./store.js";
import { isQuietHour } from "./eligibility.js";

const subtractMs = (date: Date, ms: number): string => new Date(date.getTime() - ms).toISOString();
const addMs = (date: Date, ms: number): string => new Date(date.getTime() + ms).toISOString();
const normaliseJid = (jid: string): string => jid.trim().toLowerCase();
const PHONE_JID_REGEX = /^(\d{7,15})@s\.whatsapp\.net$/iu;
const RETRY_DELAY_MS = 15 * 60 * 1000;

export const trimSpotlightBody = (body: string, maxLength: number): string => {
  const trimmed = body.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const slice = trimmed.slice(0, Math.max(0, maxLength - 1));
  const lastSpace = slice.lastIndexOf(" ");
  const wordSafe = lastSpace >= Math.floor(maxLength * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${wordSafe.trimEnd()}…`;
};

export const buildSpotlightMessage = (config: Config, body: string): string => {
  const marketplaceName = config.ticketMarketplaceGroupName;
  return `🎟️ Ticket available in ${marketplaceName}

${trimSpotlightBody(body, config.ticketSpotlightMaxLength)}

— Reply in *${marketplaceName}* to connect.`;
};

export const formatObfuscatedPhone = (jid: string): string | null => {
  const match = jid.match(PHONE_JID_REGEX);
  const digits = match?.[1];
  if (!digits) {
    return null;
  }

  return `+${digits.slice(0, 4)}...${digits.slice(-4)}`;
};

export const findSpotlightPhoneJid = (
  senderJid: string,
  aliases: ReadonlyArray<{ alias: string; aliasType: string }> = [],
): string | null => {
  if (formatObfuscatedPhone(senderJid)) {
    return senderJid;
  }

  return aliases.find((alias) => alias.aliasType === "phone" && formatObfuscatedPhone(alias.alias))?.alias ?? null;
};

export const formatSpotlightSenderLabel = (pending: SpotlightPendingRow): string | null => {
  const summary = describeUser(pending.senderUserId);
  const displayName = summary?.displayName?.trim() || null;
  const phone = formatObfuscatedPhone(findSpotlightPhoneJid(pending.senderJid, summary?.aliases) ?? pending.senderJid);

  if (displayName && phone) {
    return `${displayName} (${phone})`;
  }

  return displayName ?? phone;
};

export const buildSpotlightMessageForPending = (
  config: Config,
  pending: SpotlightPendingRow,
): string => {
  const marketplaceName = config.ticketMarketplaceGroupName;
  const header = pending.classifiedIntent === "buying"
    ? `🔎 Someone's looking for a ticket in ${marketplaceName}`
    : `🎟️ Ticket available in ${marketplaceName}`;
  const senderLabel = formatSpotlightSenderLabel(pending);
  const body = trimSpotlightBody(pending.body, config.ticketSpotlightMaxLength);
  const bodyWithSender = senderLabel ? `${senderLabel}:\n${body}` : body;

  return `${header}

${bodyWithSender}

— Reply in *${marketplaceName}* to connect.`;
};

const getDailyCapForPending = (config: Config, pending: SpotlightPendingRow): number =>
  pending.classifiedIntent === "buying"
    ? config.ticketSpotlightBuyingMaxPerDay
    : config.ticketSpotlightSellingMaxPerDay;

export const sendClaimedSpotlight = async (
  sock: WASocket,
  config: Config,
  pending: SpotlightPendingRow,
  claimedBy: string,
  targetGroupJids: readonly string[],
  now = new Date(),
): Promise<void> => {
  if (!config.ticketSpotlightEnabled) {
    cancelClaimedSpotlight(pending.id, claimedBy, "disabled");
    warn("spotlight.cancelled.disabled", { pendingId: pending.id });
    return;
  }

  if (isQuietHour(now, config.ticketSpotlightQuietHours, config.ticketSpotlightTimezone)) {
    const scheduledAt = addMs(now, RETRY_DELAY_MS);
    rescheduleClaimedSpotlight(pending.id, claimedBy, scheduledAt);
    warn("spotlight.deferred.quiet_hours", { pendingId: pending.id, scheduledAt });
    return;
  }

  if (config.ticketSpotlightBlocklistJids.map(normaliseJid).includes(normaliseJid(pending.senderJid))) {
    cancelClaimedSpotlight(pending.id, claimedBy, "blocklisted");
    warn("spotlight.cancelled.blocklisted", { pendingId: pending.id, senderJid: pending.senderJid });
    return;
  }

  const userSince = subtractMs(now, config.ticketSpotlightUserCooldownHours * 60 * 60 * 1000);
  if (hasUserSpotlightSince(pending.senderUserId, userSince)) {
    cancelClaimedSpotlight(pending.id, claimedBy, "user_cooldown");
    warn("spotlight.cancelled.user_cooldown", { pendingId: pending.id, senderUserId: pending.senderUserId });
    return;
  }

  const sentAt = now.toISOString();
  const message = buildSpotlightMessageForPending(config, pending);
  let sentCount = 0;
  const skippedReasons = new Set<string>();

  for (const targetGroupJid of targetGroupJids) {
    const groupSince = subtractMs(now, config.ticketSpotlightGroupCooldownMinutes * 60 * 1000);
    if (hasTargetGroupSpotlightSince(targetGroupJid, groupSince)) {
      skippedReasons.add("group_cooldown");
      warn("spotlight.skipped.group_cooldown", { pendingId: pending.id, targetGroupJid });
      continue;
    }

    const daySince = subtractMs(now, 24 * 60 * 60 * 1000);
    if (getTargetGroupSpotlightCountSince(targetGroupJid, daySince) >= getDailyCapForPending(config, pending)) {
      skippedReasons.add("daily_cap");
      warn("spotlight.skipped.daily_cap", { pendingId: pending.id, targetGroupJid });
      continue;
    }

    try {
      await sock.sendMessage(targetGroupJid, { text: message });
      recordSpotlightHistory(pending, targetGroupJid, sentAt);
      sentCount += 1;
      log("spotlight.sent", { pendingId: pending.id, targetGroupJid });
    } catch (sendError) {
      skippedReasons.add("send_failed");
      warn("spotlight.send_failed", { pendingId: pending.id, targetGroupJid, error: sendError });
    }
  }

  if (sentCount === 0) {
    if (skippedReasons.has("group_cooldown") || skippedReasons.has("send_failed")) {
      const scheduledAt = addMs(now, RETRY_DELAY_MS);
      rescheduleClaimedSpotlight(pending.id, claimedBy, scheduledAt);
      warn("spotlight.deferred.no_targets_available", {
        pendingId: pending.id,
        scheduledAt,
        reasons: Array.from(skippedReasons),
      });
      return;
    }

    const cancelReason = skippedReasons.has("daily_cap") ? "daily_cap" : "no_targets_available";
    cancelClaimedSpotlight(pending.id, claimedBy, cancelReason);
    warn(`spotlight.cancelled.${cancelReason}`, { pendingId: pending.id, reasons: Array.from(skippedReasons) });
    return;
  }

  markSpotlightSent(pending.id, claimedBy, sentAt);
};
