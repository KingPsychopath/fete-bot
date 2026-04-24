import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../../../config.js";
import type { SpotlightPendingRow } from "../../../db.js";
import { log, warn } from "../../../logger.js";
import {
  cancelClaimedSpotlight,
  getTargetGroupSpotlightCountSince,
  hasTargetGroupSpotlightSince,
  hasUserSpotlightSince,
  markSpotlightSent,
  recordSpotlightHistory,
} from "./store.js";
import { isQuietHour } from "./eligibility.js";

const subtractMs = (date: Date, ms: number): string => new Date(date.getTime() - ms).toISOString();
const normaliseJid = (jid: string): string => jid.trim().toLowerCase();

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
  return `🎟️ From ${marketplaceName}

${trimSpotlightBody(body, config.ticketSpotlightMaxLength)}

— Reply in *${marketplaceName}* to connect.`;
};

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
    cancelClaimedSpotlight(pending.id, claimedBy, "quiet_hours");
    warn("spotlight.cancelled.quiet_hours", { pendingId: pending.id });
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
  const message = buildSpotlightMessage(config, pending.body);
  let sentCount = 0;

  for (const targetGroupJid of targetGroupJids) {
    const groupSince = subtractMs(now, config.ticketSpotlightGroupCooldownMinutes * 60 * 1000);
    if (hasTargetGroupSpotlightSince(targetGroupJid, groupSince)) {
      warn("spotlight.cancelled.group_cooldown", { pendingId: pending.id, targetGroupJid });
      continue;
    }

    const daySince = subtractMs(now, 24 * 60 * 60 * 1000);
    if (getTargetGroupSpotlightCountSince(targetGroupJid, daySince) >= config.ticketSpotlightMaxPerDay) {
      warn("spotlight.cancelled.daily_cap", { pendingId: pending.id, targetGroupJid });
      continue;
    }

    await sock.sendMessage(targetGroupJid, { text: message });
    recordSpotlightHistory(pending, targetGroupJid, sentAt);
    sentCount += 1;
    log("spotlight.sent", { pendingId: pending.id, targetGroupJid });
  }

  if (sentCount === 0) {
    cancelClaimedSpotlight(pending.id, claimedBy, "no_targets_available");
    warn("spotlight.cancelled.no_targets_available", { pendingId: pending.id });
    return;
  }

  markSpotlightSent(pending.id, claimedBy, sentAt);
};
