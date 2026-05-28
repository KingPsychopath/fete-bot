import type { CleanupMember, CleanupStats } from "./store.js";

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

  const batchesRemaining = Math.ceil(stats.dmPending / stats.campaign.batchSize);
  const batchLabel = `${batchesRemaining} batch${batchesRemaining === 1 ? "" : "es"}`;

  if (stats.campaign.status === "paused") {
    return `${batchLabel} remaining, paused`;
  }

  if (stats.campaign.status !== "active") {
    return `${batchLabel} remaining, not running`;
  }

  const firstBatchAt = Math.max(nowMs, stats.nextBatchAt ?? nowMs);
  const lastBatchAt = firstBatchAt + Math.max(0, batchesRemaining - 1) * stats.campaign.batchIntervalMinutes * 60_000;
  return `${formatTime(lastBatchAt, nowMs)} (${batchLabel})`;
};

export const buildCleanupPublicMessage = (durationLabel: string, channelLink: string | null): string =>
  [
    "📣 *Out of Office Collective Fete Community Cleanup*",
    "",
    "The OOOC Fete is full, so we need to make space for active members, especially as Fete is approaching soon.",
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
    "Hey, The OOOC Fete is full, so we're cleaning inactive members, especially as Fete is approaching soon.",
    "",
    `If you want to stay in the chat community, please *reply to this message* or *react* within *${durationLabel}*. Any reaction or reply counts.`,
    "",
    channelLink
      ? `If you only want official drops and announcements, follow the WhatsApp Channel here:\n${channelLink}`
      : "If you only want official drops and announcements, follow the WhatsApp Channel.",
    "",
    "If removed from the chats, you'll still be able to follow announcements through the Channel.",
  ].join("\n");

export const buildCleanupWhitelistConfirmationMessage = (channelLink: string | null): string =>
  [
    "✅ Noted — you're on the stay list for The OOOC Fete chats.",
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
      const signal = member.whitelistReason ? ` via ${member.whitelistReason}` : "";
      const dm = member.dmStatus !== "pending" ? `, DM ${member.dmStatus}` : "";
      return `${index + 1}. ${memberLabel(member)}${signal}${dm}`;
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
    `DM batches: ${stats.campaign.batchSize} every ${stats.campaign.batchIntervalMinutes}m`,
    `Estimated DM finish: ${getDmBatchEstimate(stats, false, stats.campaign.startedAt)}`,
    "",
    "Bot safety: cleanup never removes members. It only lists candidates for admins.",
    "",
    "Use `!cleanup status` for the compact dashboard.",
  ].join("\n");
