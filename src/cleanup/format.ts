import type { CleanupMember, CleanupStats } from "./store.js";
import { CLEANUP_DM_RATE_LIMIT, cleanupDmRateLabel } from "./policy.js";

const formatPercent = (value: number, total: number): string =>
  total > 0 ? `${((value / total) * 100).toFixed(1)}%` : "0.0%";

const formatDurationLeft = (targetMs: number, nowMs = Date.now()): string => {
  const remainingMs = Math.max(0, targetMs - nowMs);
  const totalMinutes = Math.ceil(remainingMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours <= 0) {
    return `${minutes}m`;
  }
  return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
};

const formatTime = (ms: number | null, nowMs = Date.now()): string => {
  if (!ms) {
    return "not scheduled";
  }
  if (ms <= nowMs) {
    return "now";
  }
  return `in ${formatDurationLeft(ms, nowMs)}`;
};

const getDmBatchEstimate = (stats: CleanupStats, hardPauseDms: boolean, nowMs = Date.now()): string => {
  if (stats.dmPending <= 0) {
    return "complete";
  }

  if (hardPauseDms) {
    return "hard-paused";
  }

  const batchesRemaining = Math.ceil(stats.dmPending / CLEANUP_DM_RATE_LIMIT.messagesPerWindow);
  const batchLabel = `${batchesRemaining} batch${batchesRemaining === 1 ? "" : "es"}`;

  if (stats.campaign.status === "paused") {
    return `${batchLabel} remaining, paused`;
  }

  if (stats.campaign.status !== "active") {
    return `${batchLabel} remaining, not running`;
  }

  const firstBatchAt = Math.max(nowMs, stats.nextBatchAt ?? nowMs);
  const lastBatchAt = firstBatchAt + Math.max(0, batchesRemaining - 1) * CLEANUP_DM_RATE_LIMIT.windowMinutes * 60_000;
  return `${formatTime(lastBatchAt, nowMs)} (${batchLabel})`;
};

export const buildCleanupPublicMessage = (durationLabel: string, channelLink: string | null): string =>
  [
    "📣 *Out of Office Collective Fete Community Cleanup*",
    "",
    "The OOOC Fete group chats are full, so we need to make space for active members, especially as Fete is approaching soon.",
    "",
    `If you want to stay in the chat community, please *react to this message* or *reply here* within the next *${durationLabel}*. Any reaction or reply counts.`,
    "",
    channelLink
      ? `If you are removed from the chats, you can still follow the WhatsApp Channel for official drops and announcements:\n${channelLink}`
      : "If you are removed from the chats, you can still follow the WhatsApp Channel for official drops and announcements.",
    "",
    "After the cleanup window, inactive accounts may be removed from the chats to make space for people waiting to join.",
  ].join("\n");

export const buildCleanupDmMessage = (durationLabel: string, channelLink: string | null): string =>
  [
    "📣 *Out of Office Collective Fete Community Cleanup*",
    "",
    "Hey - quick one from the OOOC Fete group chats. The chats are full, so we're checking who still wants to stay in before Fete.",
    "",
    `If you still want to be in the OOOC Fete group chats, just *reply to this message* or *react* within *${durationLabel}*. Any reaction or reply counts.`,
    "",
    channelLink
      ? `If you only want official drops and announcements, you can follow the WhatsApp Channel instead:\n${channelLink}`
      : "If you only want official drops and announcements, you can follow the WhatsApp Channel instead.",
    "",
    "No stress if not. If you do get removed from the chats, you can still keep up through the Channel.",
  ].join("\n");

export const buildCleanupWhitelistConfirmationMessage = (channelLink: string | null): string =>
  [
    "✅ Noted — you're on the stay list for the OOOC Fete group chats.",
    "",
    channelLink
      ? `You can also follow the Channel for official drops and announcements:\n${channelLink}`
      : "You can also follow the Channel for official drops and announcements.",
  ].join("\n");

export const formatCleanupStatus = (
  stats: CleanupStats,
  nowMs = Date.now(),
  options: { hardPauseDms?: boolean } = {},
): string => {
  const { campaign } = stats;
  const hardPauseDms = Boolean(options.hardPauseDms);
  return [
    "🧹 *Cleanup status*",
    "",
    `Status: *${campaign.status}*`,
    `Cleanup DMs: *${hardPauseDms ? "hard-paused" : "enabled"}*`,
    `DM safety rate: ${cleanupDmRateLabel()}, ${Math.round(CLEANUP_DM_RATE_LIMIT.perMessageDelayMs / 1000)}s apart`,
    `Time left: *${formatDurationLeft(campaign.endsAt, nowMs)}*`,
    `Whitelist: *${stats.whitelisted}/${stats.total}* (${formatPercent(stats.whitelisted, stats.total)})`,
    `No signal: *${stats.noSignal}*`,
    "",
    `Signals: reactions ${stats.signals.public_reaction + stats.signals.dm_reaction}, replies ${stats.signals.public_reply + stats.signals.dm_reply}, activity ${stats.signals.group_activity}, protected ${stats.signals.protected}`,
    `DMs: sent ${stats.dmSent}, pending ${stats.dmPending}, failed ${stats.dmFailed}, skipped ${stats.dmSkipped}`,
    `Next batch: ${hardPauseDms ? "hard-paused" : stats.nextBatchSize > 0 ? `${stats.nextBatchSize} DM${stats.nextBatchSize === 1 ? "" : "s"} ${formatTime(stats.nextBatchAt, nowMs)}` : "none"}`,
    `DM finish: ${getDmBatchEstimate(stats, hardPauseDms, nowMs)}`,
    "",
    "Bot safety: cleanup never removes members. It only lists candidates for admins.",
  ].join("\n");
};

const memberLabel = (member: CleanupMember): string =>
  `${member.displayName?.trim() || member.primaryJid} (${member.primaryJid})`;

const cleanupSignalLabel = (reason: CleanupMember["whitelistReason"]): string => {
  if (!reason) {
    return "";
  }
  if (reason === "manual") {
    return "manually kept";
  }
  return `via ${reason}`;
};

const cleanupDmStatusLabel = (status: CleanupMember["dmStatus"]): string => {
  if (status === "pending") {
    return "";
  }
  if (status === "skipped") {
    return "no cleanup DM needed";
  }
  return `DM ${status}`;
};

export const formatCleanupMemberList = (
  title: string,
  members: CleanupMember[],
  emptyText: string,
): string => {
  if (members.length === 0) {
    return emptyText;
  }

  return [
    title,
    "",
    ...members.map((member, index) => {
      const details = [
        cleanupSignalLabel(member.whitelistReason),
        cleanupDmStatusLabel(member.dmStatus),
      ].filter(Boolean);
      return `${index + 1}. ${memberLabel(member)}${details.length > 0 ? `, ${details.join(", ")}` : ""}`;
    }),
  ].join("\n");
};

export const formatCleanupStarted = (
  stats: CleanupStats,
  publicTargets: readonly string[],
): string =>
  [
    "✅ Cleanup campaign started.",
    "",
    `Window: ${formatDurationLeft(stats.campaign.endsAt, stats.campaign.startedAt)}`,
    `Tracked members: ${stats.total}`,
    `Already whitelisted/protected: ${stats.whitelisted}`,
    `Public notices sent: ${publicTargets.length}`,
    `DM safety rate: ${cleanupDmRateLabel()}, ${Math.round(CLEANUP_DM_RATE_LIMIT.perMessageDelayMs / 1000)}s apart`,
    `Estimated DM finish: ${getDmBatchEstimate(stats, false, stats.campaign.startedAt)}`,
    "",
    "Bot safety: cleanup never removes members. It only lists candidates for admins.",
    "",
    "Use `!cleanup status` for the compact dashboard.",
  ].join("\n");
