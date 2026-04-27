import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type GroupMetadata,
  type AnyMessageContent,
  type MiscMessageGenerationOptions,
  type WASocket,
  type WACallEvent,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import pino from "pino";
import QRCode from "qrcode";

import { startAnnouncementScheduler, stopAnnouncementScheduler } from "./announcements/scheduler.js";
import { config, NEVER_SPOTLIGHT_GROUP_JIDS } from "./config.js";
import { handleAuthorisedCommand, handleGroupCommand } from "./commands.js";
import {
  addBan,
  addStrike,
  addMute,
  closeDb,
  clearReviewQueueEntry,
  getGlobalBans,
  initDb,
  isBanned,
  isMuted,
  logAction,
  purgeExpiredMutes,
  purgeExpiredStrikes,
  upsertReviewQueueEntry,
} from "./db.js";
import { runStartupHealthCheck } from "./healthCheck.js";
import { loadLidMappings, recordLidMapping } from "./lidMap.js";
import { containsDisallowedUrl } from "./linkChecker.js";
import { buildGroupInviteLinkReply, classifyGroupInviteLinkRequest } from "./moderation/groupInviteLink.js";
import { isTicketMarketplaceRefutation } from "./moderation/ticketMarketplace/classifier.js";
import { getTicketMarketplaceDecision } from "./moderation/ticketMarketplace/index.js";
import { TicketMarketplaceReplyCooldown } from "./moderation/ticketMarketplace/replyCooldown.js";
import { getSpotlightEligibility } from "./moderation/ticketMarketplace/spotlight/eligibility.js";
import { startSpotlightScheduler, stopSpotlightScheduler } from "./moderation/ticketMarketplace/spotlight/scheduler.js";
import { cancelSpotlightsForSource, hasPendingSpotlightForSender, queueSpotlight } from "./moderation/ticketMarketplace/spotlight/store.js";
import {
  recordTicketMarketplaceRuleReminderActivity,
  startTicketMarketplaceRuleReminderScheduler,
  stopTicketMarketplaceRuleReminderScheduler,
} from "./moderation/ticketMarketplace/ruleReminder.js";
import { SpamDetector, type SpamReason } from "./spamDetector.js";
import { error, log, warn } from "./logger.js";
import { consumeQuietSwitchSendBypass, isQuietSwitchEnabled } from "./quietSwitch.js";
import { isTicketMarketplaceDeletionEnabled } from "./ticketMarketplaceDeletion.js";
import {
  AUTH_DIR,
  DATABASE_PATH,
  DATA_DIR,
  EFFECTIVE_STORAGE_MODE,
  RAILWAY_VOLUME_ATTACHED,
  ensureStorageDirs,
  migrateLegacyAuthDir,
} from "./storagePaths.js";
import {
  buildSelfJids,
  describeUser,
  findExistingUserIdsByAliases,
  findParticipantJidForUser,
  mergeUserAliases,
  normalizeJid,
  resolveUser,
  type ResolvedUser,
} from "./identity.js";
import { extractAllIdentifiers, isProtectedGroupMember, parseToJid } from "./utils.js";
import { STARTED_AT, VERSION } from "./version.js";

const spamDetector = new SpamDetector({
  duplicateMinLength: config.spamDuplicateMinLength,
  floodWarnMessageLimit: config.spamFloodWarnMessageLimit,
  floodDeleteMessageLimit: config.spamFloodDeleteMessageLimit,
});
const discoveredGroups = new Map<string, string>();
const discoveredGroupMetadata = new Map<string, GroupMetadata>();
const mutedMessageCounts = new Map<string, number>();
const handledCallOfferIds = new Set<string>();
const ticketMarketplaceReplyCooldown = new TicketMarketplaceReplyCooldown(
  config.ticketMarketplaceReplyCooldownMinutes * 60 * 1000,
);
let strikePurgeTimer: ReturnType<typeof setInterval> | null = null;
let mutePurgeTimer: ReturnType<typeof setInterval> | null = null;
let globalBanEnforcementTimer: ReturnType<typeof setInterval> | null = null;
let activeSocket: WASocket | null = null;
let shuttingDown = false;
let reconnecting = false;
let reconnectAttempts = 0;
let socketInstanceCounter = 0;
let botSelfJids = new Set<string>();

const healthPort = Number(process.env.PORT ?? "3000");
const healthServer = createServer((req, res) => {
  if (req.url === "/health") {
    const connected = activeSocket?.user !== undefined;
    res.writeHead(200);
    res.end(connected ? "OK" : "WAITING_FOR_WHATSAPP");
    return;
  }

  if (req.url === "/ready") {
    const connected = activeSocket?.user !== undefined;
    res.writeHead(connected ? 200 : 503);
    res.end(connected ? "OK" : "DISCONNECTED");
    return;
  }

  res.writeHead(404);
  res.end();
});

let healthServerStarted = false;
let healthServerErrored = false;

healthServer.on("error", (serverError) => {
  const code = typeof serverError === "object" && serverError !== null && "code" in serverError
    ? String((serverError as { code?: string }).code)
    : undefined;

  if (code === "EADDRINUSE") {
    healthServerErrored = true;
    warn(`Health endpoint port ${healthPort} is already in use. Continuing without binding /health.`);
    return;
  }

  error("Health endpoint server error", serverError);
});

const isBoomLike = (value: unknown): value is { output?: { statusCode?: number } } =>
  typeof value === "object" && value !== null && "output" in value;

const installQuietSwitchSendGuard = (sock: WASocket): void => {
  const originalSendMessage = sock.sendMessage.bind(sock);
  sock.sendMessage = (async (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => {
    if (isQuietSwitchEnabled() && !consumeQuietSwitchSendBypass(content)) {
      warn("Quiet switch blocked outgoing bot message", {
        jid,
        keys: typeof content === "object" && content !== null ? Object.keys(content) : [],
      });
      return undefined;
    }

    return originalSendMessage(jid, content, options);
  }) as WASocket["sendMessage"];
};

type MessageContextInfo = {
  participant?: string | null;
  isForwarded?: boolean | null;
  forwardingScore?: number | null;
  stanzaId?: string | null;
  quotedMessage?: unknown;
};

const getMessageContextInfo = (message: WAMessage["message"]): MessageContextInfo | null => {
  if (!message) {
    return null;
  }

  for (const value of Object.values(message as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null || !("contextInfo" in value)) {
      continue;
    }

    const contextInfo = (value as { contextInfo?: MessageContextInfo | null }).contextInfo;
    if (contextInfo) {
      return contextInfo;
    }
  }

  return null;
};

const extractTextFromMessageContent = (message: WAMessage["message"]): string => {
  if (!message) {
    return "";
  }

  const documentWithCaption = (
    message.documentWithCaptionMessage as
      | { message?: { documentMessage?: { caption?: string | null } | null } | null }
      | undefined
  )?.message?.documentMessage?.caption;

  return (
    message.conversation ??
    message.extendedTextMessage?.text ??
    message.imageMessage?.caption ??
    message.videoMessage?.caption ??
    message.documentMessage?.caption ??
    documentWithCaption ??
    ""
  );
};

const extractMessageText = (msg: WAMessage): string => extractTextFromMessageContent(msg.message);

const getQuotedParticipant = (message: WAMessage["message"]): string | null => {
  return getMessageContextInfo(message)?.participant ?? null;
};

const getQuotedText = (message: WAMessage["message"]): string | null => {
  const quotedMessage = getMessageContextInfo(message)?.quotedMessage;
  const text = extractTextFromMessageContent(quotedMessage as WAMessage["message"]);
  return text.trim() ? text : null;
};

const hasQuotedMessage = (message: WAMessage["message"]): boolean => {
  const contextInfo = getMessageContextInfo(message);
  return Boolean(contextInfo?.quotedMessage || contextInfo?.stanzaId);
};

const getPushName = (msg: WAMessage): string | null => msg.pushName ?? null;

const getPhoneJid = (phoneNumber: string | null): string | null =>
  phoneNumber ? parseToJid(phoneNumber) : null;

const refreshSelfJids = (sock: WASocket): ReadonlySet<string> => {
  botSelfJids = buildSelfJids(sock.user);
  return botSelfJids;
};

const getSelfJids = (sock: WASocket): ReadonlySet<string> => {
  if (botSelfJids.size === 0) {
    return refreshSelfJids(sock);
  }

  return botSelfJids;
};

const isForwardedMessage = (message: WAMessage["message"]): boolean => {
  const contextInfo = getMessageContextInfo(message);
  return Boolean(contextInfo?.isForwarded || (contextInfo?.forwardingScore ?? 0) >= 5);
};

const MENTIONABLE_JID_REGEX = /@(s\.whatsapp\.net|lid)$/i;

const getMentionableToken = (senderJid: string, phoneJid?: string | null): string | null => {
  const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
  return mentionTargetJid ? (mentionTargetJid.split("@")[0] ?? null) : null;
};

const getMentionTextToken = (
  senderJid: string,
  _pushName: string | null,
  phoneJid?: string | null,
): string => {
  return getMentionableToken(senderJid, phoneJid) ?? "there";
};

const getMentionTargetJid = (senderJid: string, phoneJid?: string | null): string => {
  for (const candidateJid of [senderJid, phoneJid]) {
    if (candidateJid && MENTIONABLE_JID_REGEX.test(candidateJid)) {
      return candidateJid;
    }
  }

  return "";
};

const formatMentionLabel = (
  senderJid: string,
  pushName: string | null,
  phoneJid?: string | null,
): string => {
  const mentionToken = getMentionTextToken(senderJid, pushName, phoneJid);
  return mentionToken === "there" ? "there" : `@${mentionToken}`;
};

const sendModerationMessage = async (
  sock: WASocket,
  groupJid: string,
  text: string,
  mentionTargetJid: string,
  quotedMessage?: WAMessage,
): Promise<void> => {
  if (!mentionTargetJid || !MENTIONABLE_JID_REGEX.test(mentionTargetJid)) {
    const plainText = text.replace(/@\S+\s+-\s+/u, "").replace(/@\S+/u, "there");
    await sock.sendMessage(groupJid, { text: plainText }, quotedMessage ? { quoted: quotedMessage } : undefined);
    return;
  }

  log("Mention debug", {
    text,
    mentions: [mentionTargetJid],
    tokenInText: text.match(/@([^ ]+)/)?.[1] ?? null,
    jidUserPart: mentionTargetJid.split("@")[0] ?? null,
  });

  await sock.sendMessage(groupJid, {
    text,
    mentions: [mentionTargetJid],
  }, quotedMessage ? { quoted: quotedMessage } : undefined);
};

const getMutedCounterKey = (userJid: string, groupJid: string): string => `${groupJid}::${userJid}`;

const getWarningText = (
  senderJid: string,
  pushName: string | null,
  reason?: string,
  phoneJid?: string | null,
): string => {
  const mentionLabel = formatMentionLabel(senderJid, pushName, phoneJid);

  if (reason === "whatsapp invite link") {
    return `Hey ${mentionLabel} - WhatsApp group invite links aren't allowed in here 🙏`;
  }

  if (reason === "ticket platform") {
    return `Hey ${mentionLabel} - please use fete.outofofficecollective.co.uk to share event links 🙏`;
  }

  if (reason === "tiktok video (profile links only)") {
    return `Hey ${mentionLabel} - TikTok profile links only please. Share their profile page instead of a specific video 🎵`;
  }

  if (reason === "youtube (music.youtube.com only)") {
    return `Hey ${mentionLabel} - only YouTube Music links are allowed for YouTube (music.youtube.com) 🎵`;
  }

  if (reason === "url shortener") {
    return `Hey ${mentionLabel} - shortened links aren't allowed. Please share the full URL instead 🙏`;
  }

  return `Hey ${mentionLabel} — please keep links to social profiles, music, or accommodation only. For events, post at fete.outofofficecollective.co.uk 🙏`;
};

const getSpamWarningText = (
  senderJid: string,
  pushName: string | null,
  reason: SpamReason,
  phoneJid?: string | null,
): string => {
  const mentionLabel = formatMentionLabel(senderJid, pushName, phoneJid);

  if (reason === "duplicate_message") {
    return `Hey ${mentionLabel} - please don't send the same message multiple times 🙏`;
  }

  if (reason === "message_flood") {
    return `Hey ${mentionLabel} - you're sending messages too quickly. Slow down please 🙏`;
  }

  return `Hey ${mentionLabel} - please don't share phone numbers in the group. For event info use fete.outofofficecollective.co.uk 🙏`;
};

const getGroupCallWarningText = (callerJid: string): string => {
  const mentionTargetJid = getMentionTargetJid(callerJid);
  const mentionToken = mentionTargetJid ? (mentionTargetJid.split("@")[0] ?? "there") : "there";
  const mentionLabel = mentionToken === "there" ? "there" : `@${mentionToken}`;
  return config.groupCallGuardWarningText.replace(/\{mention\}/gu, mentionLabel);
};

const appendStrikeWarning = (warningText: string, strikeCount: number): string => {
  if (strikeCount === 2) {
    return `${warningText}\n\n⚠️ This is your second warning — one more and you'll be removed from the group.`;
  }

  return warningText;
};

const notifyOwnersOfStrikeThree = async (
  sock: WASocket,
  senderJid: string,
  groupJid: string,
  pushName: string | null,
  reason: string,
  phoneJid?: string | null,
): Promise<void> => {
  const groupName = discoveredGroups.get(groupJid) ?? groupJid;
  const dmText = `⚠️ Strike 3 — Removal Request

User: ${pushName ?? "Unknown"} (${phoneJid ?? senderJid})
Group: ${groupName} (${groupJid})
Last offence: ${reason}
Active strikes: 3
${config.muteOnStrike3 ? "\nStatus: Auto-muted until an owner or moderator reviews this case" : ""}

Reply with:
!remove ${phoneJid ?? senderJid} ${groupJid} — to remove them
!pardon ${phoneJid ?? senderJid} ${groupJid} — to reset their strikes`;

  for (const ownerJid of config.ownerJids) {
    try {
      await sock.sendMessage(ownerJid, { text: dmText });
    } catch (dmError) {
      error("Failed to DM owner about strike three escalation", {
        ownerJid,
        senderJid,
        groupJid,
        error: dmError,
      });
    }
  }
};

const logConfig = (): void => {
  log("Loaded config", config);
  log("Storage paths", {
    dataDir: DATA_DIR,
    databasePath: DATABASE_PATH,
    authDir: AUTH_DIR,
    storageMode: EFFECTIVE_STORAGE_MODE,
    railwayVolumeMountPath: process.env.RAILWAY_VOLUME_MOUNT_PATH ?? null,
    railwayVolumeAttached: RAILWAY_VOLUME_ATTACHED,
  });

  if (process.env.RAILWAY_VOLUME_MOUNT_PATH && RAILWAY_VOLUME_ATTACHED === false) {
    warn(
      "RAILWAY_VOLUME_MOUNT_PATH is set but does not exist in the container. Storage will be ephemeral until the Railway volume is attached to this service.",
    );
  }

  if (config.allowedGroupJids.length === 0) {
    warn("ALLOWED_GROUP_JIDS is empty, so the bot will act in all joined groups.");
  }

  if (config.groupCallGuardEnabled && config.groupCallGuardGroupJids.length === 0) {
    warn("GROUP_CALL_GUARD_GROUP_JIDS is empty, so call guard will act in all managed groups.");
  }

  if (config.ticketMarketplaceManagement && config.ticketMarketplaceGroupJids.length === 0) {
    warn("TICKET_MARKETPLACE_MANAGEMENT is enabled but TICKET_MARKETPLACE_GROUP_JIDS is empty.");
  }
};

const isManagedGroup = (groupJid: string): boolean =>
  config.allowedGroupJids.length === 0 || config.allowedGroupJids.includes(groupJid);

const isGroupCallGuarded = (groupJid: string): boolean =>
  config.groupCallGuardEnabled &&
  isManagedGroup(groupJid) &&
  (config.groupCallGuardGroupJids.length === 0 || config.groupCallGuardGroupJids.includes(groupJid));

const shouldRejectUnknownGroupCall = (call: WACallEvent): boolean =>
  config.groupCallGuardEnabled &&
  call.isGroup === true &&
  config.allowedGroupJids.length === 0 &&
  config.groupCallGuardGroupJids.length === 0;

const getCallGroupJid = (call: WACallEvent): string | null => {
  for (const candidate of [call.groupJid, call.chatId]) {
    if (candidate?.endsWith("@g.us")) {
      return candidate;
    }
  }

  return null;
};

const getEffectiveTicketSpotlightTargetJids = (): string[] => {
  const candidateTargetJids = config.ticketSpotlightTargetJids.length > 0
    ? config.ticketSpotlightTargetJids
    : Array.from(discoveredGroups.keys());

  return candidateTargetJids.filter(
    (groupJid) =>
      isManagedGroup(groupJid) &&
      !config.ticketMarketplaceGroupJids.includes(groupJid) &&
      !NEVER_SPOTLIGHT_GROUP_JIDS.includes(groupJid as (typeof NEVER_SPOTLIGHT_GROUP_JIDS)[number]),
  );
};

const handleCall = async (sock: WASocket, call: WACallEvent): Promise<void> => {
  log("Received call event", {
    callId: call.id,
    status: call.status,
    chatId: call.chatId,
    callerJid: call.from,
    groupJid: call.groupJid ?? null,
    isGroup: call.isGroup ?? null,
    isVideo: call.isVideo ?? null,
    offline: call.offline,
  });

  if (call.status !== "offer") {
    handledCallOfferIds.delete(call.id);
    return;
  }

  if (handledCallOfferIds.has(call.id)) {
    return;
  }

  const groupJid = getCallGroupJid(call);
  if (!groupJid && shouldRejectUnknownGroupCall(call)) {
    handledCallOfferIds.add(call.id);

    if (config.dryRun) {
      warn("Dry run: would reject group call without group JID", {
        callId: call.id,
        chatId: call.chatId,
        callerJid: call.from,
        isVideo: call.isVideo,
      });
      return;
    }

    try {
      await sock.rejectCall(call.id, call.from);
      warn("Rejected group call without group JID", {
        callId: call.id,
        chatId: call.chatId,
        callerJid: call.from,
        isVideo: call.isVideo,
      });
    } catch (callGuardError) {
      handledCallOfferIds.delete(call.id);
      error("Failed to reject group call without group JID", {
        callId: call.id,
        chatId: call.chatId,
        callerJid: call.from,
        isVideo: call.isVideo,
        error: callGuardError,
      });
    }
    return;
  }

  if (!groupJid || !isGroupCallGuarded(groupJid)) {
    warn("Ignored call offer outside call guard scope", {
      callId: call.id,
      chatId: call.chatId,
      callerJid: call.from,
      groupJid,
      isGroup: call.isGroup ?? null,
      guardEnabled: config.groupCallGuardEnabled,
      managedGroup: groupJid ? isManagedGroup(groupJid) : false,
      guardGroupJidsConfigured: config.groupCallGuardGroupJids.length,
    });
    return;
  }

  handledCallOfferIds.add(call.id);
  const warningText = getGroupCallWarningText(call.from);
  const mentionTargetJid = getMentionTargetJid(call.from);

  if (config.dryRun) {
    warn("Dry run: would reject group call and send warning", {
      callId: call.id,
      groupJid,
      callerJid: call.from,
      isVideo: call.isVideo,
      wouldSendText: warningText,
    });
    return;
  }

  try {
    await sock.rejectCall(call.id, call.from);
    await sendModerationMessage(sock, groupJid, warningText, mentionTargetJid);
    warn("Rejected group call and warned chat", {
      callId: call.id,
      groupJid,
      callerJid: call.from,
      isVideo: call.isVideo,
    });
  } catch (callGuardError) {
    handledCallOfferIds.delete(call.id);
    error("Failed to reject group call", {
      callId: call.id,
      groupJid,
      callerJid: call.from,
      isVideo: call.isVideo,
      error: callGuardError,
    });
  }
};

const isSelfParticipant = (
  participant: Pick<GroupMetadata["participants"][number], "id" | "lid" | "phoneNumber">,
  selfJids: ReadonlySet<string>,
): boolean => {
  for (const candidate of [
    participant.id ?? null,
    participant.lid ?? null,
    participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
  ]) {
    if (candidate && selfJids.has(candidate)) {
      return true;
    }
  }

  return false;
};

const syncLidMappingIdentity = async (
  lidJid: string | null | undefined,
  phoneNumber: string | null | undefined,
  sock: WASocket,
): Promise<void> => {
  const normalizedPhoneJid = phoneNumber ? parseToJid(phoneNumber) : null;
  if (!lidJid || !normalizedPhoneJid) {
    return;
  }

  try {
    recordLidMapping(normalizedPhoneJid, lidJid);
    await resolveUser({
      participantJid: lidJid,
      phoneJid: normalizedPhoneJid,
      lidJid,
      selfJids: getSelfJids(sock),
      reason: "metadata_sync",
    });
  } catch (mappingError) {
    warn("Failed to sync lid mapping identity", {
      lidJid,
      phoneJid: normalizedPhoneJid,
      error: mappingError,
    });
  }
};

const syncGroupParticipantIdentities = async (metadata: GroupMetadata): Promise<void> => {
  const selfJids = botSelfJids;
  for (const participant of metadata.participants) {
    if (isSelfParticipant(participant, selfJids)) {
      continue;
    }

    try {
      await resolveUser({
        participantJid: participant.id ?? null,
        phoneJid: participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
        lidJid: participant.lid ?? null,
        selfJids,
        reason: "metadata_sync",
      });
    } catch (participantError) {
      warn("Failed to sync participant identity from group metadata", {
        groupJid: metadata.id,
        participantId: participant.id,
        error: participantError,
      });
    }
  }
};

const resolveDirectSenderFromKnownGroups = async (
  sender: ResolvedUser,
  remoteJid: string,
  pushName: string | null,
  sock: WASocket,
): Promise<ResolvedUser> => {
  const directAliases = new Set(
    [remoteJid, sender.participantJid, ...sender.knownAliases]
      .filter((alias): alias is string => Boolean(alias))
      .map((alias) => normalizeJid(alias)),
  );

  for (const metadata of discoveredGroupMetadata.values()) {
    for (const participant of metadata.participants) {
      const participantAliases = [
        participant.id ? normalizeJid(participant.id) : null,
        participant.lid ? normalizeJid(participant.lid) : null,
        participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
      ].filter((alias): alias is string => Boolean(alias));

      if (!participantAliases.some((alias) => directAliases.has(alias))) {
        continue;
      }

      await syncLidMappingIdentity(participant.lid, participant.phoneNumber, sock);
      const resolved = await resolveUser({
        participantJid: participant.id ?? sender.participantJid,
        phoneJid: participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
        lidJid: participant.lid ?? (remoteJid.endsWith("@lid") ? remoteJid : null),
        pushName,
        selfJids: getSelfJids(sock),
        reason: "metadata_sync",
      });

      return resolved ?? sender;
    }
  }

  return sender;
};

const resolveDirectSenderFromOwnerAliases = async (
  sender: ResolvedUser,
  selfJids: ReadonlySet<string>,
): Promise<ResolvedUser> => {
  for (const ownerJid of config.ownerJids) {
    const ownerUserIds = findExistingUserIdsByAliases([ownerJid]);
    const senderUserIds = findExistingUserIdsByAliases([sender.participantJid, ...sender.knownAliases]);
    if (!ownerUserIds.some((userId) => senderUserIds.includes(userId))) {
      continue;
    }

    const merged = await mergeUserAliases([ownerJid, sender.participantJid, ...sender.knownAliases], selfJids, "manual_admin");
    if (merged?.knownAliases.includes(normalizeJid(ownerJid))) {
      return merged;
    }
  }

  return sender;
};

const listDiscoveredGroups = async (
  sock: WASocket,
): Promise<void> => {
  try {
    const groups = await sock.groupFetchAllParticipating();
    discoveredGroups.clear();
    discoveredGroupMetadata.clear();

    for (const [jid, metadata] of Object.entries(groups)) {
      discoveredGroups.set(jid, metadata.subject);
      discoveredGroupMetadata.set(jid, metadata);
      log("Discovered group", { jid, subject: metadata.subject });
      if (botSelfJids.size > 0) {
        await syncGroupParticipantIdentities(metadata);
      }
    }
  } catch (groupError) {
    warn("Unable to fetch participating groups", groupError);
  }
};

const refreshGroupMetadata = async (sock: WASocket, groupJid: string): Promise<void> => {
  try {
    const metadata = await sock.groupMetadata(groupJid);
    discoveredGroups.set(groupJid, metadata.subject);
    discoveredGroupMetadata.set(groupJid, metadata);
    if (botSelfJids.size > 0) {
      await syncGroupParticipantIdentities(metadata);
    }
  } catch (groupError) {
    warn("Unable to refresh group metadata", { groupJid, error: groupError });
  }
};

const enforceGlobalBans = async (sock: WASocket): Promise<void> => {
  if (config.dryRun) {
    return;
  }

  const globalBans = getGlobalBans();
  if (globalBans.length === 0 || discoveredGroupMetadata.size === 0) {
    return;
  }

  for (const [groupJid, metadata] of discoveredGroupMetadata.entries()) {
    if (!isManagedGroup(groupJid)) {
      continue;
    }

    for (const ban of globalBans) {
      const summary = describeUser(ban.userId);
      const candidateAliases = summary?.aliases.map((alias) => alias.alias) ?? [];
      if (isProtectedGroupMember(ban.userId, candidateAliases, groupJid, config, discoveredGroupMetadata)) {
        continue;
      }

      const liveParticipantJid = findParticipantJidForUser(ban.userId, metadata);
      if (!liveParticipantJid) {
        continue;
      }

      try {
        await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
        warn("Auto-removed globally banned user", { userId: ban.userId, groupJid });
      } catch (globalBanError) {
        error("Failed to auto-remove globally banned user", { userId: ban.userId, groupJid, error: globalBanError });
      }
    }
  }
};

const buildErrorLogMessage = (messageText: string, moderationError: unknown): string => {
  const errorMessage =
    moderationError instanceof Error ? moderationError.message : String(moderationError);

  return messageText.length > 0
    ? `${messageText}\n[ERROR] ${errorMessage}`
    : `[ERROR] ${errorMessage}`;
};

const queueTicketSpotlightIfEligible = async (
  sock: WASocket,
  msg: WAMessage,
  groupJid: string,
  senderUserId: string,
  senderJid: string,
  text: string,
  ticketDecision: ReturnType<typeof getTicketMarketplaceDecision>,
): Promise<void> => {
  if (!config.ticketSpotlightEnabled || !config.ticketMarketplaceGroupJids.includes(groupJid)) {
    return;
  }

  const targetGroupJids = getEffectiveTicketSpotlightTargetJids();
  if (targetGroupJids.length === 0) {
    log("spotlight.cancelled.no_targets", { groupJid, senderJid });
    return;
  }

  const messageId = msg.key.id;
  if (!messageId) {
    warn("spotlight.cancelled.no_source_msg_id", { groupJid, senderJid });
    return;
  }

  const eligibility = getSpotlightEligibility(config, {
    groupJid,
    senderJid,
    text,
    intent: ticketDecision.intent,
    hasPrice: ticketDecision.hasPrice,
    isReply: hasQuotedMessage(msg.message),
    isCommand: text.trim().startsWith("!"),
    fromMe: Boolean(msg.key.fromMe),
  });

  if (!eligibility.eligible) {
    log(`spotlight.cancelled.${eligibility.reason}`, {
      groupJid,
      senderJid,
      sourceMsgId: messageId,
      classification: ticketDecision.intent,
    });
    return;
  }

  if (config.dryRun) {
    log("Dry run: would queue ticket spotlight", {
      groupJid,
      senderJid,
      sourceMsgId: messageId,
      classification: ticketDecision.intent,
    });
    return;
  }

  if (hasPendingSpotlightForSender(senderUserId)) {
    log("spotlight.cancelled.sender_pending", {
      groupJid,
      senderJid,
      sourceMsgId: messageId,
      classification: ticketDecision.intent,
    });
    return;
  }

  const delayMinutes = ticketDecision.intent === "buying"
    ? config.ticketSpotlightBuyingDelayMinutes
    : config.ticketSpotlightSellingDelayMinutes;
  const scheduledAt = new Date(Date.now() + delayMinutes * 60_000).toISOString();
  const queued = queueSpotlight({
    sourceGroupJid: groupJid,
    sourceMsgId: messageId,
    senderUserId,
    senderJid,
    body: text,
    classifiedIntent: ticketDecision.intent === "selling" ? "selling" : "buying",
    scheduledAt,
  });

  if (queued) {
    log("spotlight.queued", {
      pendingId: queued.id,
      groupJid,
      senderJid,
      sourceMsgId: messageId,
      scheduledAt,
      classification: ticketDecision.intent,
    });

    try {
      await sock.sendMessage(groupJid, {
        react: {
          text: config.ticketSpotlightReactionEmoji,
          key: msg.key,
        },
      });
      log("spotlight.reacted", {
        pendingId: queued.id,
        groupJid,
        senderJid,
        sourceMsgId: messageId,
        reactionEmoji: config.ticketSpotlightReactionEmoji,
      });
    } catch (reactionError) {
      warn("spotlight.reaction_failed", {
        pendingId: queued.id,
        groupJid,
        senderJid,
        sourceMsgId: messageId,
        error: reactionError,
      });
    }
  }
};

export const handleMessage = async (
  sock: WASocket,
  msg: WAMessage,
): Promise<void> => {
  try {
    if (!msg.message) {
      return;
    }

    if (msg.key.fromMe) {
      return;
    }

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) {
      return;
    }

    const text = extractMessageText(msg);
    const selfJids = getSelfJids(sock);
    const { senderJid, phoneNumber, lidJid } = extractAllIdentifiers(msg);
    const phoneJid = getPhoneJid(phoneNumber);
    const isDirectChat = remoteJid.endsWith("@s.whatsapp.net") || remoteJid.endsWith("@lid");
    const sender = await resolveUser({
      participantJid: senderJid || null,
      phoneJid,
      lidJid,
      pushName: getPushName(msg),
      selfJids,
    }) ?? (isDirectChat
      ? await resolveUser({
          participantJid: remoteJid,
          phoneJid: remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null,
          lidJid: remoteJid.endsWith("@lid") ? remoteJid : null,
          pushName: getPushName(msg),
          selfJids,
        })
      : null);

    if (!sender) {
      if (isDirectChat && text.trim().startsWith("!")) {
        await sock.sendMessage(remoteJid, {
          text: `⛔ You're not authorised to use Fete Bot commands. Ignoring this command.

Raw identity:
Remote JID: ${remoteJid}
Sender JID: ${senderJid || "unknown"}
Phone JID: ${phoneJid ?? "unknown"}
Phone number: ${phoneNumber ?? "unknown"}
LID JID: ${lidJid ?? "unknown"}
Push name: ${getPushName(msg) ?? "unknown"}`,
        });
      }
      return;
    }

    if (isDirectChat) {
      const directSenderFromGroups = await resolveDirectSenderFromKnownGroups(sender, remoteJid, getPushName(msg), sock);
      const directSender = await resolveDirectSenderFromOwnerAliases(directSenderFromGroups, selfJids);
      if (text) {
        await handleAuthorisedCommand(
          sock,
          directSender,
          text,
          getQuotedText(msg.message),
          config,
          discoveredGroups,
          discoveredGroupMetadata,
          selfJids,
        );
      }
      return;
    }

    if (!sender.participantJid) {
      return;
    }

    const liveSenderJid = sender.participantJid;
    const canonicalSenderAlias = phoneJid ?? liveSenderJid;

    const groupJid = remoteJid;
    if (!groupJid.endsWith("@g.us")) {
      return;
    }

    log(`Seen message from group JID: ${groupJid} — ${getPushName(msg) ?? "Unknown"}`);

    if (!isManagedGroup(groupJid)) {
      return;
    }

    if (config.ticketMarketplaceGroupJids.includes(groupJid)) {
      recordTicketMarketplaceRuleReminderActivity(groupJid);
    }

    if (text) {
      const handledGroupCommand = await handleGroupCommand(
        sock,
        sender,
        groupJid,
        text,
        getQuotedParticipant(msg.message),
        config,
        discoveredGroups,
        discoveredGroupMetadata,
        selfJids,
      );

      if (handledGroupCommand) {
        return;
      }
    }

    if (
      isProtectedGroupMember(
        sender.userId,
        sender.knownAliases,
        groupJid,
        config,
        discoveredGroupMetadata,
      )
    ) {
      return;
    }

    if (text.startsWith("!")) {
      warn("Ignored in-group command from unauthorised sender", {
        groupJid,
        senderJid: liveSenderJid,
        phoneJid,
        lidJid,
        pushName: getPushName(msg),
        text,
      });
    }

    try {
      if (isBanned(sender.userId, groupJid)) {
        if (config.dryRun) {
          warn("Dry run: would remove banned user who sent a message", {
            senderJid: canonicalSenderAlias,
            lidJid,
            groupJid,
          });
          return;
        }

        try {
          await sock.groupParticipantsUpdate(groupJid, [liveSenderJid], "remove");
          warn("Auto-removed banned user after message attempt", {
            senderJid: canonicalSenderAlias,
            lidJid,
            groupJid,
          });

          for (const ownerJid of config.ownerJids) {
            await sock.sendMessage(ownerJid, {
              text: `🚫 Banned user tried to post and was auto-removed.

User: ${canonicalSenderAlias}
Group: ${groupJid}

Use !unban ${canonicalSenderAlias} ${groupJid} to lift the ban.`,
            }).catch(() => {});
          }
        } catch (bannedRemovalError) {
          error("Failed to auto-remove banned user after message attempt", {
            senderJid: canonicalSenderAlias,
            groupJid,
            error: bannedRemovalError,
          });
        }

        return;
      }
    } catch (banError) {
      error("Failed banned-user message check", { senderJid, groupJid, error: banError });
    }

    if (isForwardedMessage(msg.message)) {
      logAction({
        timestamp: new Date().toISOString(),
        group_jid: groupJid,
        user_id: sender.userId,
        participant_jid: liveSenderJid,
        push_name: getPushName(msg),
        message_text: text || null,
        url_found: null,
        action: "WARN",
        reason: "forwarded message",
      });
      log("Forwarded message observed", {
        groupJid,
        senderJid: canonicalSenderAlias,
        pushName: getPushName(msg),
      });
    }

    if (!text) {
      return;
    }

    try {
      if (isMuted(sender.userId, groupJid)) {
        const mutedCounterKey = getMutedCounterKey(sender.userId, groupJid);
        const mutedAttemptCount = (mutedMessageCounts.get(mutedCounterKey) ?? 0) + 1;
        mutedMessageCounts.set(mutedCounterKey, mutedAttemptCount);

        if (!config.dryRun) {
          await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        }

        warn("Deleted message from muted user", { senderJid: canonicalSenderAlias, lidJid, groupJid });
        logAction({
          timestamp: new Date().toISOString(),
          group_jid: groupJid,
          user_id: sender.userId,
          participant_jid: liveSenderJid,
          push_name: msg.pushName ?? "",
          message_text: text,
          url_found: null,
          action: config.dryRun ? "DRY_RUN" : "DELETED",
          reason: "muted user",
        });

        if (mutedAttemptCount >= 3) {
          mutedMessageCounts.delete(mutedCounterKey);

          if (!config.dryRun) {
            try {
              addBan(
                sender.userId,
                groupJid,
                { userId: null, label: "system" },
                "repeated attempts to post while muted pending review",
              );
              clearReviewQueueEntry(sender.userId, groupJid);
              await sock.groupParticipantsUpdate(groupJid, [liveSenderJid], "remove");
              await sock.sendMessage(groupJid, {
                text: "A muted member has been banned and removed after repeatedly attempting to post while muted.",
              });
            } catch (removeMutedError) {
              error("Failed to ban and remove muted user after repeated attempts", {
                senderJid: canonicalSenderAlias,
                groupJid,
                error: removeMutedError,
              });
            }
          }

          for (const ownerJid of config.ownerJids) {
            await sock.sendMessage(ownerJid, {
              text: `🔇 Muted user escalation

User: ${canonicalSenderAlias}
Group: ${groupJid}
Attempts while muted: ${mutedAttemptCount}

They have been banned and removed after repeatedly trying to post while muted.`,
            }).catch(() => {});
          }
        }

        return;
      }
    } catch (muteError) {
      error("Failed mute check", { senderJid, groupJid, error: muteError });
    }

    const isCommandText = text.trim().startsWith("!");
    if (!isCommandText) {
      const groupInviteLinkRequest = classifyGroupInviteLinkRequest(text);

      if (groupInviteLinkRequest.matched) {
        const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
        const mentionLabel = formatMentionLabel(senderJid, getPushName(msg), phoneJid);
        const replyText = buildGroupInviteLinkReply(mentionLabel);
        const logEntry = {
          timestamp: new Date().toISOString(),
          group_jid: groupJid,
          user_id: sender.userId,
          participant_jid: liveSenderJid,
          push_name: getPushName(msg),
          message_text: text,
          url_found: null,
          reason: groupInviteLinkRequest.reason,
        };

        if (config.dryRun) {
          logAction({
            ...logEntry,
            action: "DRY_RUN",
          });

          warn("Dry run: would respond to group invite link request", {
            groupJid,
            senderJid: canonicalSenderAlias,
            matchedSignal: groupInviteLinkRequest.matchedSignal,
            wouldSendText: replyText,
          });

          return;
        }

        try {
          await sendModerationMessage(sock, groupJid, replyText, mentionTargetJid, msg);
          logAction({
            ...logEntry,
            action: "WARN",
          });

          log("Responded to group invite link request", {
            groupJid,
            senderJid: canonicalSenderAlias,
            matchedSignal: groupInviteLinkRequest.matchedSignal,
          });
        } catch (moderationError) {
          logAction({
            ...logEntry,
            action: "ERROR",
            message_text: buildErrorLogMessage(text, moderationError),
          });

          error("Failed to respond to group invite link request", {
            groupJid,
            senderJid: canonicalSenderAlias,
            matchedSignal: groupInviteLinkRequest.matchedSignal,
            error: moderationError,
          });
        }

        return;
      }

      const refutationNow = Date.now();
      if (
        ticketMarketplaceReplyCooldown.isCoolingDown(groupJid, sender.userId, refutationNow) &&
        isTicketMarketplaceRefutation(text)
      ) {
        ticketMarketplaceReplyCooldown.record(groupJid, sender.userId, refutationNow);
        log("Extended ticket marketplace reply cooldown after refutation", {
          groupJid,
          senderJid: canonicalSenderAlias,
          cooldownMinutes: config.ticketMarketplaceReplyCooldownMinutes,
        });
      }

      const ticketDecision = getTicketMarketplaceDecision(config, groupJid, text);

      if (ticketDecision.reason) {
        log("Ticket marketplace decision", {
          groupJid,
          senderJid: canonicalSenderAlias,
          classification: ticketDecision.intent,
          matchedTokens: ticketDecision.matchedTokens,
          matchedSignals: ticketDecision.matchedSignals,
          pricePresent: ticketDecision.hasPrice,
          action: ticketDecision.action,
          dryRun: config.dryRun,
        });
      }

      if (ticketDecision.action !== "allow") {
        const shouldDeleteTicketMarketplaceMessage = isTicketMarketplaceDeletionEnabled();
        const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
        const mentionLabel = formatMentionLabel(senderJid, getPushName(msg), phoneJid);
        const marketplaceName = config.ticketMarketplaceGroupName;
        const replyText = ticketDecision.action === "redirect_buying"
          ? `Hey ${mentionLabel} - looking to buy tickets? Please post in ${marketplaceName}.`
          : ticketDecision.action === "redirect_selling"
            ? `Hey ${mentionLabel} - ticket sales belong in ${marketplaceName}. Please repost there.`
            : `Hey ${mentionLabel} - ticket sale posts must include a price, or say face value / FV.`;
        const logEntry = {
          timestamp: new Date().toISOString(),
          group_jid: groupJid,
          user_id: sender.userId,
          participant_jid: liveSenderJid,
          push_name: getPushName(msg),
          message_text: text,
          url_found: null,
          reason: ticketDecision.reason,
        };
        const cooldownNow = Date.now();
        const replyCoolingDown = ticketMarketplaceReplyCooldown.isCoolingDown(groupJid, sender.userId, cooldownNow);

        if (replyCoolingDown) {
          log("Suppressed ticket marketplace reply during cooldown", {
            groupJid,
            senderJid: canonicalSenderAlias,
            classification: ticketDecision.intent,
            matchedTokens: ticketDecision.matchedTokens,
            matchedSignals: ticketDecision.matchedSignals,
            pricePresent: ticketDecision.hasPrice,
            action: ticketDecision.action,
            deletionEnabled: shouldDeleteTicketMarketplaceMessage,
            cooldownMinutes: config.ticketMarketplaceReplyCooldownMinutes,
          });
        }

        if (config.dryRun) {
          if (!replyCoolingDown) {
            logAction({
              ...logEntry,
              action: "DRY_RUN",
            });
            ticketMarketplaceReplyCooldown.record(groupJid, sender.userId, cooldownNow);
          }

          warn("Dry run: would moderate ticket marketplace rule", {
            groupJid,
            senderJid: canonicalSenderAlias,
            classification: ticketDecision.intent,
            matchedTokens: ticketDecision.matchedTokens,
            matchedSignals: ticketDecision.matchedSignals,
            pricePresent: ticketDecision.hasPrice,
            action: ticketDecision.action,
            deletionEnabled: shouldDeleteTicketMarketplaceMessage,
            replySuppressedByCooldown: replyCoolingDown,
            wouldSendText: replyCoolingDown ? null : replyText,
          });
          return;
        }

        try {
          if (shouldDeleteTicketMarketplaceMessage) {
            await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
          }

          if (!replyCoolingDown) {
            await sendModerationMessage(sock, groupJid, replyText, mentionTargetJid, msg);
            ticketMarketplaceReplyCooldown.record(groupJid, sender.userId, cooldownNow);
          }

          if (!replyCoolingDown || shouldDeleteTicketMarketplaceMessage) {
            logAction({
              ...logEntry,
              action: shouldDeleteTicketMarketplaceMessage ? "DELETED" : "WARN",
            });
          }

          warn(
            replyCoolingDown
              ? "Moderated ticket marketplace rule during reply cooldown"
              : "Responded to ticket marketplace rule",
            {
              groupJid,
              senderJid: canonicalSenderAlias,
              classification: ticketDecision.intent,
              matchedTokens: ticketDecision.matchedTokens,
              matchedSignals: ticketDecision.matchedSignals,
              pricePresent: ticketDecision.hasPrice,
              action: ticketDecision.action,
              deletionEnabled: shouldDeleteTicketMarketplaceMessage,
              replySuppressedByCooldown: replyCoolingDown,
            },
          );
        } catch (moderationError) {
          logAction({
            ...logEntry,
            action: "ERROR",
            message_text: buildErrorLogMessage(text, moderationError),
          });

          error("Failed to moderate ticket marketplace rule", {
            groupJid,
            senderJid: canonicalSenderAlias,
            classification: ticketDecision.intent,
            action: ticketDecision.action,
            error: moderationError,
          });
        }

        return;
      }

      await queueTicketSpotlightIfEligible(
        sock,
        msg,
        groupJid,
        sender.userId,
        canonicalSenderAlias,
        text,
        ticketDecision,
      );
    }

    log("Allowed group message", {
      groupJid,
      senderJid: canonicalSenderAlias,
      lidJid,
      pushName: getPushName(msg),
      text,
    });

    const moderationResult = containsDisallowedUrl(text);
    const baseLogEntry = {
      timestamp: new Date().toISOString(),
      group_jid: groupJid,
      user_id: sender.userId,
      participant_jid: liveSenderJid,
      push_name: getPushName(msg),
      message_text: text,
      url_found: null as string | null,
      reason: null as string | null,
    };

    if (moderationResult.found && moderationResult.url) {
      const pushName = getPushName(msg);
      const warningText = getWarningText(senderJid, pushName, moderationResult.reason, phoneJid);
      const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
      const logEntry = {
        ...baseLogEntry,
        url_found: moderationResult.url,
        reason: moderationResult.reason ?? null,
      };

      if (config.dryRun) {
        log("Dry run matched disallowed link in allowed group", {
          groupJid,
          senderJid: canonicalSenderAlias,
          url: moderationResult.url,
          reason: moderationResult.reason,
          wouldSendText: warningText,
        });

        logAction({
          ...logEntry,
          action: "DRY_RUN",
        });

        warn("Dry run: would delete disallowed link", {
          groupJid,
          senderJid: canonicalSenderAlias,
          url: moderationResult.url,
          reason: moderationResult.reason,
        });
        return;
      }

      try {
        await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        const strikeCount = addStrike(
          sender.userId,
          groupJid,
          moderationResult.reason ?? "unknown",
          randomUUID(),
        );
        await sendModerationMessage(
          sock,
          groupJid,
          appendStrikeWarning(warningText, strikeCount),
          mentionTargetJid,
        );

        if (strikeCount >= 3) {
          upsertReviewQueueEntry(
            sender.userId,
            groupJid,
            pushName,
            moderationResult.reason ?? "unknown",
            text,
          );
          if (config.muteOnStrike3) {
            addMute(
              sender.userId,
              groupJid,
              { userId: null, label: "system" },
              null,
              "auto-muted after strike 3 pending review",
            );
          }
          const flaggedText = `${formatMentionLabel(senderJid, pushName, phoneJid)} has been flagged for removal after repeated violations. An owner or moderator will review shortly.${config.muteOnStrike3 ? " They have been muted until review." : ""}`;
          await sendModerationMessage(sock, groupJid, flaggedText, mentionTargetJid);
          await notifyOwnersOfStrikeThree(
            sock,
            canonicalSenderAlias,
            groupJid,
            pushName,
            moderationResult.reason ?? "unknown",
            phoneJid,
          );
        }

        logAction({
          ...logEntry,
          action: "DELETED",
        });

        warn("Deleted disallowed link", {
          groupJid,
          senderJid: canonicalSenderAlias,
          url: moderationResult.url,
          reason: moderationResult.reason,
        });
      } catch (moderationError) {
        logAction({
          ...logEntry,
          action: "ERROR",
          message_text: buildErrorLogMessage(text, moderationError),
        });

        error("Failed to moderate message", {
          groupJid,
          senderJid: canonicalSenderAlias,
          url: moderationResult.url,
          error: moderationError,
        });
      }
      return;
    }

    const spamResult = spamDetector.check(sender.userId, groupJid, text);
    if (!spamResult.spam) {
      return;
    }

    const spamWarningText = getSpamWarningText(
      senderJid,
      getPushName(msg),
      spamResult.reason,
      phoneJid,
    );
    const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
    const spamLogEntry = {
      ...baseLogEntry,
      reason: spamResult.reason,
    };

    if (config.dryRun) {
        log("Dry run matched spam rule in allowed group", {
          groupJid,
          senderJid: canonicalSenderAlias,
          reason: spamResult.reason,
          action: spamResult.action,
          wouldSendText: spamWarningText,
      });

      logAction({
        ...spamLogEntry,
        action: "DRY_RUN",
      });

      warn("Dry run: would moderate spam detection", {
        groupJid,
        senderJid: canonicalSenderAlias,
        reason: spamResult.reason,
        action: spamResult.action,
      });
      return;
    }

    try {
      if (spamResult.action === "delete") {
        await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        const strikeCount = addStrike(
          sender.userId,
          groupJid,
          spamResult.reason,
          randomUUID(),
        );
        await sendModerationMessage(
          sock,
          groupJid,
          appendStrikeWarning(spamWarningText, strikeCount),
          mentionTargetJid,
        );

        if (strikeCount >= 3) {
          upsertReviewQueueEntry(
            sender.userId,
            groupJid,
            getPushName(msg),
            spamResult.reason,
            text,
          );
          if (config.muteOnStrike3) {
            addMute(
              sender.userId,
              groupJid,
              { userId: null, label: "system" },
              null,
              "auto-muted after strike 3 pending review",
            );
          }
          const flaggedText = `${formatMentionLabel(senderJid, getPushName(msg), phoneJid)} has been flagged for removal after repeated violations. An owner or moderator will review shortly.${config.muteOnStrike3 ? " They have been muted until review." : ""}`;
          await sendModerationMessage(sock, groupJid, flaggedText, mentionTargetJid);
          await notifyOwnersOfStrikeThree(
            sock,
            canonicalSenderAlias,
            groupJid,
            getPushName(msg),
            spamResult.reason,
            phoneJid,
          );
        }
      } else {
        await sendModerationMessage(sock, groupJid, spamWarningText, mentionTargetJid);
      }

      logAction({
        ...spamLogEntry,
        action: spamResult.action === "delete" ? "DELETED" : "WARN",
      });

      warn("Moderated spam detection", {
        groupJid,
        senderJid: canonicalSenderAlias,
        reason: spamResult.reason,
        action: spamResult.action,
      });
    } catch (moderationError) {
      logAction({
        ...spamLogEntry,
        action: "ERROR",
        message_text: buildErrorLogMessage(text, moderationError),
      });

      error("Failed to moderate spam detection", {
        groupJid,
        senderJid: canonicalSenderAlias,
        reason: spamResult.reason,
        error: moderationError,
      });
    }
  } catch (handlerError) {
    error("Unhandled error in message handler", handlerError);
  }
};

export const startBot = async (): Promise<void> => {
  const socketInstanceId = ++socketInstanceCounter;
  migrateLegacyAuthDir();
  ensureStorageDirs();
  initDb();
  await loadLidMappings();
  purgeExpiredStrikes();
  purgeExpiredMutes();
  if (!healthServerStarted && !healthServerErrored) {
    healthServer.listen(healthPort, () => {
      log(`Health endpoint listening on port ${healthPort}`);
    });
    healthServerStarted = true;
  }
  if (!strikePurgeTimer) {
    strikePurgeTimer = setInterval(() => {
      purgeExpiredStrikes();
    }, 60 * 60 * 1000);
    strikePurgeTimer.unref();
  }
  if (!mutePurgeTimer) {
    mutePurgeTimer = setInterval(() => {
      purgeExpiredMutes();
    }, 60 * 60 * 1000);
    mutePurgeTimer.unref();
  }
  log(`${config.botName} ${VERSION} starting at ${STARTED_AT}`);
  logConfig();

  const authFolder = AUTH_DIR;
  const { state, saveCreds } = await useMultiFileAuthState(authFolder);
  const { version, isLatest, error: versionError } = await fetchLatestBaileysVersion();

  if (versionError) {
    warn("Failed to confirm latest Baileys version", versionError);
  } else {
    log("Using Baileys version", { version, isLatest });
  }

  const sock = makeWASocket({
    auth: state,
    version,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });
  installQuietSwitchSendGuard(sock);
  activeSocket = sock;
  refreshSelfJids(sock);

  sock.ev.on("creds.update", saveCreds);
  sock.ev.on("lid-mapping.update", ({ lid, pn }) => {
    void syncLidMappingIdentity(lid, pn, sock);
  });
  if (!globalBanEnforcementTimer) {
    globalBanEnforcementTimer = setInterval(() => {
      if (activeSocket) {
        void enforceGlobalBans(activeSocket);
      }
    }, 30_000);
    globalBanEnforcementTimer.unref();
  }

  sock.ev.on("connection.update", (update) => {
    if (socketInstanceId !== socketInstanceCounter) {
      return;
    }

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log("QR received. Scan it with the WhatsApp Business account you want to use.");
      log("=== QR RAW STRING (paste into any QR generator) ===");
      process.stdout.write(`${qr}\n`);
      log("=== END RAW STRING ===");

      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      log(`QR image URL: ${qrImageUrl}`);

      QRCode.toString(qr, { type: "terminal", small: false, margin: 2 }, (err, code) => {
        if (err) {
          warn("Failed to render terminal QR code.", err);
          return;
        }

        const paddedCode = code
          .split("\n")
          .map((line) => `.${line}`)
          .join("\n");
        process.stdout.write(`\n${paddedCode}\n`);
      });
    }

    if (connection === "open") {
      reconnecting = false;
      reconnectAttempts = 0;
      refreshSelfJids(sock);
      log("Bot connected");
      void (async () => {
        await listDiscoveredGroups(sock);
        await enforceGlobalBans(sock);
        await runStartupHealthCheck(sock, config, discoveredGroupMetadata);
        startSpotlightScheduler(sock, config, getEffectiveTicketSpotlightTargetJids);
        startTicketMarketplaceRuleReminderScheduler(sock, config);
        startAnnouncementScheduler(sock, config);
      })();
      return;
    }

    if (connection === "close") {
      if (shuttingDown) {
        return;
      }

      if (activeSocket === sock) {
        activeSocket = null;
      }
      stopSpotlightScheduler();
      stopTicketMarketplaceRuleReminderScheduler();
      stopAnnouncementScheduler();

      const statusCode = isBoomLike(lastDisconnect?.error)
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const isLoggedOut = statusCode === DisconnectReason.loggedOut;
      const isReplaced = statusCode === DisconnectReason.connectionReplaced || statusCode === 440;

      if (isReplaced) {
        warn("Session replaced by another WhatsApp client. Treating as a graceful deployment handoff.", {
          statusCode,
        });
        void shutdown("connectionReplaced");
        return;
      }

      if (isLoggedOut) {
        error(`WhatsApp logged the bot out. Remove the auth folder (${authFolder}) and pair again.`, { statusCode });
        process.exit(1);
      }

      const delay = Math.min(Math.max(reconnectAttempts, 1) * 2000, 30_000);
      reconnectAttempts += 1;

      warn("Connection closed, reconnecting with backoff", { statusCode, delay, reconnectAttempts });

      if (!shuttingDown && !reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          reconnecting = false;
          void startBot();
        }, delay);
      }
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    if (!isManagedGroup(update.id)) {
      return;
    }

    await refreshGroupMetadata(sock, update.id);

    if (update.action !== "add") {
      return;
    }

    for (const rawParticipant of update.participants) {
      const participant = await resolveUser({
        participantJid: rawParticipant.id ?? null,
        phoneJid: rawParticipant.phoneNumber ? parseToJid(rawParticipant.phoneNumber) : null,
        lidJid: rawParticipant.lid ?? null,
        selfJids: getSelfJids(sock),
        reason: "metadata_sync",
      });
      if (!participant) {
        continue;
      }

      if (
        isProtectedGroupMember(
          participant.userId,
          participant.knownAliases,
          update.id,
          config,
          discoveredGroupMetadata,
        )
      ) {
        continue;
      }

      try {
        if (!isBanned(participant.userId, update.id)) {
          continue;
        }

        try {
          await sock.groupParticipantsUpdate(
            update.id,
            [findParticipantJidForUser(participant.userId, discoveredGroupMetadata.get(update.id)) ?? participant.participantJid ?? rawParticipant.id],
            "remove",
          );
          warn("Auto-removed banned user on rejoin", {
            userJid: participant.participantJid,
            groupJid: update.id,
          });

          for (const ownerJid of config.ownerJids) {
            await sock.sendMessage(ownerJid, {
              text: `🚫 Banned user attempted to rejoin and was auto-removed.

User: ${participant.knownAliases[0] ?? participant.userId}
Group: ${update.id}

Use !unban ${participant.knownAliases[0] ?? participant.userId} ${update.id} to lift the ban.`,
            });
          }
          clearReviewQueueEntry(participant.userId, update.id);
        } catch (rejoinError) {
          error("Failed to auto-remove banned user on rejoin", rejoinError);
        }
      } catch (banCheckError) {
        error("Failed banned-user rejoin check", banCheckError);
      }
    }
  });

  sock.ev.on("messages.upsert", ({ messages }) => {
    for (const message of messages) {
      void handleMessage(sock, message);
    }
  });

  sock.ev.on("call", (calls) => {
    for (const call of calls) {
      void handleCall(sock, call);
    }
  });

  sock.ev.on("messages.delete", (deleteEvent) => {
    if ("all" in deleteEvent) {
      return;
    }

    for (const key of deleteEvent.keys) {
      if (!key.remoteJid || !key.id) {
        continue;
      }

      const cancelled = cancelSpotlightsForSource(key.remoteJid, key.id, "source_deleted");
      if (cancelled > 0) {
        log("spotlight.cancelled.source_deleted", {
          groupJid: key.remoteJid,
          sourceMsgId: key.id,
          cancelled,
        });
      }
    }
  });
};

const shutdown = async (signal: string): Promise<void> => {
  if (shuttingDown) {
    return;
  }

  shuttingDown = true;
  log(`Received ${signal}, shutting down cleanly`);

  try {
    if (strikePurgeTimer) {
      clearInterval(strikePurgeTimer);
      strikePurgeTimer = null;
    }

    if (mutePurgeTimer) {
      clearInterval(mutePurgeTimer);
      mutePurgeTimer = null;
    }

    if (globalBanEnforcementTimer) {
      clearInterval(globalBanEnforcementTimer);
      globalBanEnforcementTimer = null;
    }

    stopSpotlightScheduler();
    stopTicketMarketplaceRuleReminderScheduler();
    stopAnnouncementScheduler();

    const socketToClose = activeSocket;
    activeSocket = null;
    socketToClose?.end(undefined);
  } catch (shutdownError) {
    error("Error during shutdown", shutdownError);
  }

  try {
    healthServer.close();
  } catch {
    // ignore
  }

  closeDb();
  process.exit(0);
};

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

const isDirectExecution =
  typeof process.argv[1] === "string" && process.argv[1].endsWith("/src/index.ts");

if (isDirectExecution) {
  void startBot().catch((startupError) => {
    error("Failed to start bot", startupError);
    process.exitCode = 1;
  });
}
