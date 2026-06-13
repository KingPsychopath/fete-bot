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
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import pino from "pino";
import QRCode from "qrcode";

import { startAnnouncementScheduler, stopAnnouncementScheduler } from "./announcements/scheduler.js";
import { buildCleanupWhitelistConfirmationMessage } from "./cleanup/format.js";
import { startCleanupScheduler, stopCleanupScheduler } from "./cleanup/scheduler.js";
import {
  findCleanupMemberByUserOrJid,
  findCleanupMessage,
  getOpenCleanupCampaign,
  markCleanupDmDeliveredByMessageId,
  recordCleanupSignal,
  recordCleanupSignalForOpenCampaign,
} from "./cleanup/store.js";
import { config, NEVER_SPOTLIGHT_GROUP_JIDS } from "./config.js";
import { handleAuthorisedCommand, handleGroupCommand } from "./commands.js";
import {
  addCallViolationAndCountActive,
  addBan,
  addStrike,
  addMute,
  closeDb,
  clearReviewQueueEntry,
  getDeletedMessageLogCount,
  getGlobalBans,
  getUserAliases,
  initDb,
  isBanned,
  isMuted,
  logCallGuardAudit,
  logAction,
  purgeExpiredCallViolations,
  purgeExpiredMutes,
  purgeExpiredStrikes,
  upsertReviewQueueEntry,
  type CallGuardAuditAction,
} from "./db.js";
import { runStartupHealthCheck } from "./healthCheck.js";
import { isGroupShhEnabled } from "./groupShhSwitch.js";
import { loadLidMappings, recordLidMapping } from "./lidMap.js";
import { containsDisallowedUrl } from "./linkChecker.js";
import { isLinkGraceActive } from "./linkGrace.js";
import {
  ADMIN_MENTION_OVERUSE_REPLIES,
  AdminMentionCooldown,
  hasAdminSummon,
  pickAdminMentionReply,
} from "./moderation/adminMention.js";
import { buildGroupInviteLinkReply, classifyGroupInviteLinkRequest } from "./moderation/groupInviteLink.js";
import { recordModerationReplyContext, type ModerationReplyContext } from "./moderation/moderationReplyContext.js";
import { isSpotlightSoldNotice, isTicketMarketplaceRefutation } from "./moderation/ticketMarketplace/classifier.js";
import { getTicketMarketplaceDecision } from "./moderation/ticketMarketplace/index.js";
import { TicketMarketplaceReplyCooldown } from "./moderation/ticketMarketplace/replyCooldown.js";
import { getSpotlightEligibility } from "./moderation/ticketMarketplace/spotlight/eligibility.js";
import { startSpotlightScheduler, stopSpotlightScheduler } from "./moderation/ticketMarketplace/spotlight/scheduler.js";
import {
  cancelPendingSpotlightsForSenderInGroup,
  cancelSpotlightsForSource,
  hasPendingSpotlightForSender,
  hasPendingSpotlightForSenderInGroup,
  queueSpotlight,
} from "./moderation/ticketMarketplace/spotlight/store.js";
import {
  recordTicketMarketplaceRuleReminderActivity,
  startTicketMarketplaceRuleReminderScheduler,
  stopTicketMarketplaceRuleReminderScheduler,
} from "./moderation/ticketMarketplace/ruleReminder.js";
import { SpamDetector, type SpamReason } from "./spamDetector.js";
import { error, log, warn } from "./logger.js";
import { isQuietSwitchEnabled } from "./quietSwitch.js";
import { isTicketMarketplaceDeletionEnabled } from "./ticketMarketplaceDeletion.js";
import {
  startWebsiteTicketExchangeAnnouncementScheduler,
  stopWebsiteTicketExchangeAnnouncementScheduler,
} from "./ticketExchangeWebsite/scheduler.js";
import {
  buildSpotlightWebsiteGroupPromptText,
  buildSpotlightWebsitePromptText,
  buildTicketExchangeRedirectText,
  recordSpotlightWebsiteGroupPromptSent,
  recordSpotlightWebsitePromptSent,
  shouldSendSpotlightWebsiteGroupPrompt,
  shouldSendSpotlightWebsitePrompt,
} from "./ticketExchangeWebsite/visibilityPrompt.js";
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
  getUserSummary,
  mergeUserAliases,
  normalizeJid,
  resolveUser,
  type ResolvedUser,
} from "./identity.js";
import { extractAllIdentifiers, isProtectedGroupMember, parseToJid } from "./utils.js";
import { STARTED_AT, VERSION } from "./version.js";
import { getDirectCommandReplyTargets, getKnownDirectMessageTargets, getStartupOwnerAwakeTargets } from "./directCommandReply.js";
import { getDebugRedirectSwitchState } from "./debugRedirectSwitch.js";
import { createWhatsAppAuthBackup } from "./whatsappAuthBackup.js";
import { shouldRequestWhatsAppPairingCode } from "./whatsappPairing.js";
import { getSafeSendOptionsFromEnv, installSafeSendGuard } from "./safeSend.js";

const spamDetector = new SpamDetector({
  duplicateMinLength: config.spamDuplicateMinLength,
  floodWarnMessageLimit: config.spamFloodWarnMessageLimit,
  floodDeleteMessageLimit: config.spamFloodDeleteMessageLimit,
});
const discoveredGroups = new Map<string, string>();
const discoveredGroupMetadata = new Map<string, GroupMetadata>();
const mutedMessageCounts = new Map<string, number>();
const handledCallOfferIds = new Map<string, number>();
const callGuardRecentActivityByKey = new Map<string, Map<string, number>>();
const callGuardWarningLastSentByKey = new Map<string, number>();
const ticketMarketplaceReplyCooldown = new TicketMarketplaceReplyCooldown(
  config.ticketMarketplaceReplyCooldownMinutes * 60 * 1000,
);
const adminMentionCooldown = new AdminMentionCooldown(
  config.adminMentionCooldownMinutes * 60 * 1000,
  config.adminMentionOveruseWindowMinutes * 60 * 1000,
  config.adminMentionOveruseThreshold,
);
const HANDLED_CALL_TTL_MS = 10 * 60 * 1000;
const HANDLED_CALL_MAX_ENTRIES = 5_000;
const MESSAGE_HANDLER_CONCURRENCY = 4;
const MESSAGE_HANDLER_MAX_QUEUE = 500;
const CLEANUP_DM_BACKFILL_SHORTCUT = "KEEP";
const CLEANUP_DM_BACKFILL_MARKER =
  "Hey - we've added you to the OOOC Fete group chat stay list, so you're all good. No need to reply.";
const STARTUP_OWNER_AWAKE_STATE_PATH = join(DATA_DIR, "startup-owner-awake.json");
const DIRECT_CHAT_AUTORESPONSE_STATE_PATH = join(DATA_DIR, "direct-chat-autoresponse.json");
const SPOTLIGHT_WEBSITE_GROUP_PROMPT_COOLDOWN_HOURS = 6;
let strikePurgeTimer: ReturnType<typeof setInterval> | null = null;
let mutePurgeTimer: ReturnType<typeof setInterval> | null = null;
let callViolationPurgeTimer: ReturnType<typeof setInterval> | null = null;
let globalBanEnforcementTimer: ReturnType<typeof setInterval> | null = null;
let handledCallSweepTimer: ReturnType<typeof setInterval> | null = null;
let activeSocket: WASocket | null = null;
let shuttingDown = false;
let reconnecting = false;
let reconnectAttempts = 0;
let socketInstanceCounter = 0;
let botSelfJids = new Set<string>();
let pairingCodeRequested = false;
let qrEventsSeen = 0;
let qrLimitShutdownScheduled = false;
let authBackupRetryTimer: ReturnType<typeof setTimeout> | null = null;
let startupOwnerAwakeSent = false;

type TrackedOutgoingDirectMessage = {
  purpose: "startup_owner_awake" | "direct_command_reply" | "cleanup_dm" | "spotlight_website_prompt";
  targetJid: string;
  pendingId?: string;
  campaignId?: string;
  userId?: string;
  remoteJid?: string | null;
  ownerJid?: string;
  originalJid?: string;
  inboundRemoteJid?: string;
  fallback: boolean;
  createdAt: string;
};

const trackedOutgoingDirectMessages = new Map<string, TrackedOutgoingDirectMessage>();

type StartupOwnerAwakeState = Record<string, { sentAt: string; targetJid: string; messageId: string | null }>;
type DirectChatAutoresponseState = Record<string, { sentAt: string }>;

type QueuedMessage = {
  socketInstanceId: number;
  sock: WASocket;
  message: WAMessage;
};

const messageQueue: QueuedMessage[] = [];
let activeMessageHandlers = 0;

const getPairingPhoneDigits = (phoneNumber: string | null): string | null => {
  if (!phoneNumber) {
    return null;
  }

  const jid = parseToJid(phoneNumber);
  const digits = jid?.replace(/@s\.whatsapp\.net$/i, "") ?? phoneNumber.replace(/\D/gu, "");
  return /^\d{7,15}$/u.test(digits) ? digits : null;
};

const formatPairingCode = (code: string): string => code.replace(/(.{4})/gu, "$1-").replace(/-$/u, "");

const trackOutgoingDirectMessage = (
  messageId: string | null | undefined,
  context: Omit<TrackedOutgoingDirectMessage, "createdAt">,
): void => {
  if (!messageId) {
    return;
  }

  trackedOutgoingDirectMessages.set(messageId, { ...context, createdAt: new Date().toISOString() });
  if (trackedOutgoingDirectMessages.size <= 200) {
    return;
  }

  const oldestMessageId = trackedOutgoingDirectMessages.keys().next().value as string | undefined;
  if (oldestMessageId) {
    trackedOutgoingDirectMessages.delete(oldestMessageId);
  }
};

const isDeliveredMessageStatus = (status: unknown): boolean =>
  typeof status === "number" && status >= 2;

const AUTH_BACKUP_RETRY_DELAYS_MS = [0, 5_000, 30_000, 120_000] as const;

const clearAuthBackupRetryTimer = (): void => {
  if (!authBackupRetryTimer) {
    return;
  }

  clearTimeout(authBackupRetryTimer);
  authBackupRetryTimer = null;
};

const scheduleWhatsAppAuthBackup = (attempt = 0): void => {
  const delay = AUTH_BACKUP_RETRY_DELAYS_MS[attempt];
  if (delay === undefined) {
    return;
  }

  if (attempt === 0) {
    clearAuthBackupRetryTimer();
  }

  authBackupRetryTimer = setTimeout(() => {
    authBackupRetryTimer = null;

    let shouldRetry = false;
    try {
      const authBackup = createWhatsAppAuthBackup({ dataDir: DATA_DIR, authDir: AUTH_DIR });
      if (authBackup.created) {
        log("WhatsApp auth backup created", {
          backupName: authBackup.backupName,
          backupPath: authBackup.backupPath,
          linkedIdentity: authBackup.linkedIdentity,
          removedBackupNames: authBackup.removedBackupNames,
          attempt,
        });
      } else {
        shouldRetry =
          authBackup.reason === "missing-creds" ||
          authBackup.reason === "creds-not-ready" ||
          authBackup.reason === "missing-linked-identity";
        warn("WhatsApp auth backup skipped", { ...authBackup, attempt, willRetry: shouldRetry });
      }
    } catch (authBackupError) {
      shouldRetry = true;
      error("WhatsApp auth backup failed", authBackupError);
    }

    if (shouldRetry && activeSocket) {
      scheduleWhatsAppAuthBackup(attempt + 1);
    }
  }, delay);
  authBackupRetryTimer.unref();
};

const runDmDebugSanitySend = async (sock: WASocket): Promise<void> => {
  const targetJid = process.env.DM_DEBUG_SANITY_SEND_JID?.trim() || null;
  if (!targetJid) {
    return;
  }

  try {
    const digits = targetJid.replace(/@s\.whatsapp\.net$/i, "").replace(/\D/gu, "");
    const check = await sock.onWhatsApp(digits);
    log("dm.debug.sanity.onwhatsapp", { targetJid, digits, check });
    const result = await sock.sendMessage(targetJid, { text: `sanity-${Date.now()}` });
    log("dm.debug.sanity.send_success", {
      targetJid,
      messageId: result?.key?.id ?? null,
    });
  } catch (sanityError) {
    warn("dm.debug.sanity.send_failed", { targetJid, error: sanityError });
  }
};

const readStartupOwnerAwakeState = (): StartupOwnerAwakeState => {
  try {
    const parsed = JSON.parse(readFileSync(STARTUP_OWNER_AWAKE_STATE_PATH, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const state: StartupOwnerAwakeState = {};
    for (const [ownerJid, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object") {
        continue;
      }
      const entry = value as Partial<StartupOwnerAwakeState[string]>;
      if (typeof entry.sentAt !== "string" || typeof entry.targetJid !== "string") {
        continue;
      }
      state[ownerJid] = {
        sentAt: entry.sentAt,
        targetJid: entry.targetJid,
        messageId: typeof entry.messageId === "string" ? entry.messageId : null,
      };
    }
    return state;
  } catch {
    return {};
  }
};

const readDirectChatAutoresponseState = (): DirectChatAutoresponseState => {
  try {
    return JSON.parse(readFileSync(DIRECT_CHAT_AUTORESPONSE_STATE_PATH, "utf8")) as DirectChatAutoresponseState;
  } catch {
    return {};
  }
};

const writeDirectChatAutoresponseState = (state: DirectChatAutoresponseState): void => {
  try {
    mkdirSync(dirname(DIRECT_CHAT_AUTORESPONSE_STATE_PATH), { recursive: true });
    writeFileSync(DIRECT_CHAT_AUTORESPONSE_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (writeError) {
    warn("Failed to write direct chat autoresponse state", writeError);
  }
};

const maybeSendDirectChatAutoresponse = async (
  sock: WASocket,
  remoteJid: string,
  msg: WAMessage,
  text: string,
): Promise<void> => {
  if (!config.directChatAutoresponseEnabled || !text.trim() || !config.directChatAutoresponseText.trim()) {
    return;
  }

  const nowMs = Date.now();
  const cooldownMs = config.directChatAutoresponseCooldownDays * 24 * 60 * 60 * 1000;
  const state = readDirectChatAutoresponseState();
  const previousSentAt = state[remoteJid]?.sentAt ? Date.parse(state[remoteJid].sentAt) : NaN;
  if (Number.isFinite(previousSentAt) && nowMs - previousSentAt < cooldownMs) {
    return;
  }

  await sock.sendMessage(remoteJid, { text: config.directChatAutoresponseText }, { quoted: msg });
  state[remoteJid] = { sentAt: new Date(nowMs).toISOString() };
  writeDirectChatAutoresponseState(state);
};

const writeStartupOwnerAwakeState = (state: StartupOwnerAwakeState): void => {
  try {
    writeFileSync(STARTUP_OWNER_AWAKE_STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
  } catch (stateError) {
    warn("startup.owner_awake.state_write_failed", { path: STARTUP_OWNER_AWAKE_STATE_PATH, error: stateError });
  }
};

const shouldSkipStartupOwnerAwake = (
  ownerJid: string,
  state: StartupOwnerAwakeState,
  now: Date,
): boolean => {
  if (config.startupOwnerAwakeCooldownMinutes <= 0) {
    return false;
  }

  const sentAt = state[ownerJid]?.sentAt;
  if (!sentAt) {
    return false;
  }

  const sentAtMs = new Date(sentAt).getTime();
  if (!Number.isFinite(sentAtMs)) {
    return false;
  }

  return now.getTime() - sentAtMs < config.startupOwnerAwakeCooldownMinutes * 60_000;
};

const getOwnerAwakeAliases = (ownerJid: string): string[] => {
  const userIds = findExistingUserIdsByAliases([ownerJid]);
  return Array.from(
    new Set(
      userIds.flatMap((userId) => getUserSummary(userId)?.aliases.map((alias) => alias.alias) ?? []),
    ),
  ).sort();
};

const sendStartupOwnerAwakeMessages = async (sock: WASocket): Promise<void> => {
  if (startupOwnerAwakeSent) {
    return;
  }
  startupOwnerAwakeSent = true;

  if (config.ownerJids.length === 0) {
    warn("startup.owner_awake.skipped", { reason: "no_owner_jids" });
    return;
  }

  if (!config.startupOwnerAwakeEnabled) {
    log("startup.owner_awake.skipped", { reason: "disabled" });
    return;
  }

  const now = new Date();
  const awakeState = readStartupOwnerAwakeState();
  for (const ownerJid of config.ownerJids) {
    if (shouldSkipStartupOwnerAwake(ownerJid, awakeState, now)) {
      log("startup.owner_awake.skipped", {
        ownerJid,
        reason: "cooldown",
        cooldownMinutes: config.startupOwnerAwakeCooldownMinutes,
        previous: awakeState[ownerJid],
      });
      continue;
    }

    const knownAliases = getOwnerAwakeAliases(ownerJid);
    const targetJids = getStartupOwnerAwakeTargets(ownerJid, knownAliases);
    if (targetJids.length === 0) {
      warn("startup.owner_awake.skipped", { ownerJid, knownAliases, reason: "no_user_chat_jid" });
      continue;
    }

    for (const [targetIndex, targetJid] of targetJids.entries()) {
      try {
        const result = await sock.sendMessage(targetJid, { text: "Hi, I'm awake." });
        trackOutgoingDirectMessage(result?.key?.id, {
          purpose: "startup_owner_awake",
          ownerJid,
          targetJid,
          fallback: targetIndex > 0,
        });
        log("startup.owner_awake.send_success", {
          ownerJid,
          targetJid,
          knownAliases,
          fallback: targetIndex > 0,
          messageId: result?.key?.id ?? null,
        });
        awakeState[ownerJid] = {
          sentAt: now.toISOString(),
          targetJid,
          messageId: result?.key?.id ?? null,
        };
        writeStartupOwnerAwakeState(awakeState);
        break;
      } catch (awakeError) {
        warn("startup.owner_awake.send_failed", {
          ownerJid,
          targetJid,
          knownAliases,
          fallback: targetIndex > 0,
          error: awakeError,
        });
      }
    }
  }
};

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

const cleanupSocket = (sock: WASocket): void => {
  try {
    sock.ev.removeAllListeners("creds.update");
    sock.ev.removeAllListeners("lid-mapping.update");
    sock.ev.removeAllListeners("connection.update");
    sock.ev.removeAllListeners("group-participants.update");
    sock.ev.removeAllListeners("messages.upsert");
    sock.ev.removeAllListeners("call");
    sock.ev.removeAllListeners("messages.delete");
  } catch (cleanupError) {
    warn("Failed to remove socket event listeners during cleanup", cleanupError);
  }

  try {
    sock.end(undefined);
  } catch (cleanupError) {
    warn("Failed to end socket during cleanup", cleanupError);
  }
};

const drainMessageQueue = (): void => {
  while (activeMessageHandlers < MESSAGE_HANDLER_CONCURRENCY && messageQueue.length > 0) {
    const item = messageQueue.shift();
    if (!item) {
      return;
    }

    if (item.socketInstanceId !== socketInstanceCounter || activeSocket !== item.sock) {
      continue;
    }

    activeMessageHandlers += 1;
    void handleMessage(item.sock, item.message)
      .catch((messageError) => {
        error("Message handler failed", messageError);
      })
      .finally(() => {
        activeMessageHandlers -= 1;
        drainMessageQueue();
      });
  }
};

const enqueueMessage = (socketInstanceId: number, sock: WASocket, message: WAMessage): void => {
  if (socketInstanceId !== socketInstanceCounter || activeSocket !== sock) {
    return;
  }

  if (messageQueue.length >= MESSAGE_HANDLER_MAX_QUEUE) {
    messageQueue.shift();
    warn("Dropped oldest queued message because handler queue is full", {
      maxQueue: MESSAGE_HANDLER_MAX_QUEUE,
    });
  }

  messageQueue.push({ socketInstanceId, sock, message });
  drainMessageQueue();
};

const sweepHandledCallOfferIds = (nowMs = Date.now()): void => {
  for (const [callId, handledAt] of handledCallOfferIds) {
    if (nowMs - handledAt > HANDLED_CALL_TTL_MS) {
      handledCallOfferIds.delete(callId);
    }
  }

  const overflow = handledCallOfferIds.size - HANDLED_CALL_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }

  let deleted = 0;
  for (const callId of handledCallOfferIds.keys()) {
    handledCallOfferIds.delete(callId);
    deleted += 1;

    if (deleted >= overflow) {
      return;
    }
  }
};

const markHandledCallOfferId = (callId: string, nowMs = Date.now()): void => {
  handledCallOfferIds.set(callId, nowMs);

  if (handledCallOfferIds.size > HANDLED_CALL_MAX_ENTRIES) {
    sweepHandledCallOfferIds(nowMs);
  }
};

const hasHandledCallOfferId = (callId: string, nowMs = Date.now()): boolean => {
  const handledAt = handledCallOfferIds.get(callId);
  if (!handledAt) {
    return false;
  }

  if (nowMs - handledAt > HANDLED_CALL_TTL_MS) {
    handledCallOfferIds.delete(callId);
    return false;
  }

  return true;
};

type MessageContextInfo = {
  participant?: string | null;
  mentionedJid?: string[] | null;
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

const getReactionInfo = (
  message: WAMessage["message"],
): { targetKey: WAMessageKey; emoji: string | null } | null => {
  const reactionMessage = (message as {
    reactionMessage?: { key?: WAMessageKey | null; text?: string | null } | null;
  } | null)?.reactionMessage;
  if (!reactionMessage?.key) {
    return null;
  }

  return {
    targetKey: reactionMessage.key,
    emoji: reactionMessage.text ?? null,
  };
};

const getQuotedParticipant = (message: WAMessage["message"]): string | null => {
  return getMessageContextInfo(message)?.participant ?? null;
};

const getQuotedText = (message: WAMessage["message"]): string | null => {
  const quotedMessage = getMessageContextInfo(message)?.quotedMessage;
  const text = extractTextFromMessageContent(quotedMessage as WAMessage["message"]);
  return text.trim() ? text : null;
};

const getQuotedMessageKey = (
  message: WAMessage["message"],
  groupJid: string,
): WAMessageKey | null => {
  const contextInfo = getMessageContextInfo(message);
  if (!contextInfo?.stanzaId) {
    return null;
  }

  return {
    remoteJid: groupJid,
    id: contextInfo.stanzaId,
    participant: contextInfo.participant ?? undefined,
    fromMe: false,
  };
};

const hasQuotedMessage = (message: WAMessage["message"]): boolean => {
  const contextInfo = getMessageContextInfo(message);
  return Boolean(contextInfo?.quotedMessage || contextInfo?.stanzaId);
};

const getMentionedJids = (message: WAMessage["message"]): string[] => getMessageContextInfo(message)?.mentionedJid ?? [];

const getPushName = (msg: WAMessage): string | null => msg.pushName ?? null;

const maybeLogTextField = (text: string): { text?: string } => config.logMessageText ? { text } : {};

const getPhoneJid = (phoneNumber: string | null): string | null =>
  phoneNumber ? parseToJid(phoneNumber) : null;
const getPhoneAliasFromSender = (senderJid: string | null | undefined): string | null =>
  senderJid?.endsWith("@s.whatsapp.net") ? senderJid : null;

const isUserChatJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
const isGroupChatJid = (jid: string): boolean => jid.endsWith("@g.us");
const isSystemChatJid = (jid: string): boolean =>
  jid === "status@broadcast" || jid.endsWith("@newsletter") || jid.endsWith("@broadcast");
const isDirectCommandCandidate = (remoteJid: string, text: string): boolean =>
  text.trim().startsWith("!") && !isGroupChatJid(remoteJid) && !isSystemChatJid(remoteJid);

const buildDirectCommandReplySocket = (
  sock: WASocket,
  inboundRemoteJid: string,
  inboundMessage: WAMessage,
): WASocket => Object.assign(Object.create(Object.getPrototypeOf(sock)), sock, {
  sendMessage: async (
    jid: string,
    content: AnyMessageContent,
    options?: MiscMessageGenerationOptions,
  ) => {
    const targets = getDirectCommandReplyTargets(jid, inboundRemoteJid);

    let lastError: unknown;
    for (const [targetIndex, target] of targets.entries()) {
      try {
        const directOptions =
          target === inboundRemoteJid && target.endsWith("@s.whatsapp.net") && !options?.quoted
            ? { ...options, quoted: inboundMessage }
            : options;
        log("direct.command.reply.send_attempt", {
          targetJid: target,
          originalJid: jid,
          inboundRemoteJid,
          fallback: targetIndex > 0,
          quotedInbound: directOptions?.quoted === inboundMessage,
        });
        if (target.endsWith("@s.whatsapp.net")) {
          const digits = target.replace(/@s\.whatsapp\.net$/i, "").replace(/\D/gu, "");
          try {
            const check = await sock.onWhatsApp(digits);
            log("dm.debug.onwhatsapp", { targetJid: target, digits, check });
          } catch (lookupError) {
            warn("dm.debug.onwhatsapp_failed", { targetJid: target, digits, error: lookupError });
          }
        }
        const result = await sock.sendMessage(target, content, directOptions);
        trackOutgoingDirectMessage(result?.key?.id, {
          purpose: "direct_command_reply",
          targetJid: target,
          originalJid: jid,
          inboundRemoteJid,
          fallback: targetIndex > 0,
        });
        log("direct.command.reply.send_success", {
          targetJid: target,
          originalJid: jid,
          inboundRemoteJid,
          fallback: targetIndex > 0,
          quotedInbound: directOptions?.quoted === inboundMessage,
          messageId: result?.key?.id ?? null,
        });
        return result;
      } catch (sendError) {
        lastError = sendError;
        warn("direct.command.reply.send_failed", {
          targetJid: target,
          originalJid: jid,
          inboundRemoteJid,
          fallback: targetIndex > 0,
          quotedInbound: target === inboundRemoteJid && target.endsWith("@s.whatsapp.net") && !options?.quoted,
          error: sendError,
        });
      }
    }

    throw lastError instanceof Error ? lastError : new Error("direct command reply send failed");
  },
});

const isCleanupDmBackfillMarker = (text: string): boolean =>
  [CLEANUP_DM_BACKFILL_SHORTCUT, CLEANUP_DM_BACKFILL_MARKER].some(
    (marker) => text.trim().toUpperCase() === marker.toUpperCase(),
  );

const maybeEditCleanupDmBackfillShortcut = async (
  sock: WASocket,
  remoteJid: string,
  msg: WAMessage,
  text: string,
): Promise<void> => {
  if (text.trim().toUpperCase() !== CLEANUP_DM_BACKFILL_SHORTCUT) {
    return;
  }

  try {
    await sock.sendMessage(remoteJid, {
      text: CLEANUP_DM_BACKFILL_MARKER,
      edit: msg.key,
    });
  } catch (editError) {
    warn("cleanup.dm_backfill_marker_edit_failed", {
      jid: remoteJid,
      messageId: msg.key.id ?? null,
      error: editError,
    });
  }
};

const getCleanupBackfillMatchIdentifiers = (remoteJid: string): string[] => {
  const identifiers = new Set<string>([remoteJid]);
  for (const userId of findExistingUserIdsByAliases([remoteJid])) {
    identifiers.add(userId);
    for (const alias of getUserAliases(userId)) {
      identifiers.add(alias.alias);
    }
  }
  return Array.from(identifiers);
};

const handleCleanupDmBackfillMarker = async (
  sock: WASocket,
  remoteJid: string,
  msg: WAMessage,
  text: string,
): Promise<boolean> => {
  if (!isCleanupDmBackfillMarker(text)) {
    return false;
  }

  await maybeEditCleanupDmBackfillShortcut(sock, remoteJid, msg, text);

  const campaign = getOpenCleanupCampaign();
  const identifiers = getCleanupBackfillMatchIdentifiers(remoteJid);
  const member = campaign ? findCleanupMemberByUserOrJid(campaign.id, identifiers) : null;
  if (!campaign || !member) {
    log("cleanup.dm_backfill_marker_unmatched", {
      jid: remoteJid,
      messageId: msg.key.id ?? null,
      hasCampaign: Boolean(campaign),
      identifiers,
    });
    return true;
  }

  const wasWhitelisted = member.whitelistedAt !== null;
  if (!wasWhitelisted) {
    recordCleanupSignal(campaign.id, member.userId, "manual", remoteJid, msg.key.id ?? null);
  }
  await sock.sendMessage(remoteJid, {
    react: {
      text: wasWhitelisted ? "❌" : "✅",
      key: msg.key,
    },
  });
  log("cleanup.dm_backfill_marker_recorded", {
    campaignId: campaign.id,
    userId: member.userId,
    jid: remoteJid,
    wasWhitelisted,
  });
  return true;
};

const maybeAcknowledgeCleanupSignal = async (
  sock: WASocket,
  signal: ReturnType<typeof recordCleanupSignalForOpenCampaign>,
  kind: "dm_reply" | "public_reply" | "silent",
  remoteJid: string,
  msg: WAMessage,
): Promise<void> => {
  if (!signal.firstWhitelist || !signal.campaign) {
    return;
  }

  if (kind === "dm_reply") {
    await sock.sendMessage(remoteJid, {
      text: buildCleanupWhitelistConfirmationMessage(signal.campaign.channelLink),
    });
    return;
  }

  if (kind === "public_reply") {
    await sock.sendMessage(remoteJid, {
      react: {
        text: "✅",
        key: msg.key,
      },
    });
  }
};

const recordCleanupInteraction = async (
  sock: WASocket,
  sender: ResolvedUser,
  remoteJid: string,
  msg: WAMessage,
  text: string,
  isDirectChat: boolean,
): Promise<boolean> => {
  const reactionInfo = getReactionInfo(msg.message);
  const reactionTarget = reactionInfo
    ? findCleanupMessage(reactionInfo.targetKey.remoteJid ?? remoteJid, reactionInfo.targetKey.id)
    : null;

  if (reactionTarget) {
    recordCleanupSignalForOpenCampaign(
      sender.userId,
      reactionTarget.messageType === "dm" ? "dm_reaction" : "public_reaction",
      remoteJid,
      reactionInfo?.targetKey.id ?? msg.key.id ?? null,
    );
    return true;
  }

  if (isDirectChat) {
    if (text.trim()) {
      const signal = recordCleanupSignalForOpenCampaign(sender.userId, "dm_reply", remoteJid, msg.key.id ?? null);
      await maybeAcknowledgeCleanupSignal(sock, signal, "dm_reply", remoteJid, msg);
      return Boolean(signal.campaign);
    }
    return false;
  }

  const quotedMessageKey = getQuotedMessageKey(msg.message, remoteJid);
  const quotedCleanupMessage = quotedMessageKey
    ? findCleanupMessage(remoteJid, quotedMessageKey.id)
    : null;
  const signal = recordCleanupSignalForOpenCampaign(
    sender.userId,
    quotedCleanupMessage ? "public_reply" : "group_activity",
    remoteJid,
    msg.key.id ?? quotedMessageKey?.id ?? null,
  );
  await maybeAcknowledgeCleanupSignal(
    sock,
    signal,
    quotedCleanupMessage ? "public_reply" : "silent",
    remoteJid,
    msg,
  );
  return Boolean(signal.campaign);
};

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

const maybeSendAdminSummonReply = async (
  sock: WASocket,
  msg: WAMessage,
  groupJid: string,
  senderJid: string,
  text: string,
  selfJids: ReadonlySet<string>,
): Promise<boolean> => {
  if (text.trim().startsWith("!") || !hasAdminSummon(text, getMentionedJids(msg.message), selfJids)) {
    return false;
  }

  const adminMentionNow = Date.now();
  const shouldSendOveruseReply = adminMentionCooldown.recordSummon(groupJid, adminMentionNow);

  if (shouldSendOveruseReply) {
    const replyText = pickAdminMentionReply(undefined, ADMIN_MENTION_OVERUSE_REPLIES);

    if (config.dryRun) {
      warn("Dry run: would respond to repeated admin mentions", {
        groupJid,
        senderJid,
        cooldownMinutes: config.adminMentionCooldownMinutes,
        overuseThreshold: config.adminMentionOveruseThreshold,
        overuseWindowMinutes: config.adminMentionOveruseWindowMinutes,
        wouldSendText: replyText,
      });
      return true;
    }

    try {
      await sock.sendMessage(groupJid, { text: replyText }, { quoted: msg });
      log("Responded to repeated admin mentions", {
        groupJid,
        senderJid,
        cooldownMinutes: config.adminMentionCooldownMinutes,
        overuseThreshold: config.adminMentionOveruseThreshold,
        overuseWindowMinutes: config.adminMentionOveruseWindowMinutes,
      });
    } catch (adminMentionError) {
      error("Failed to respond to repeated admin mentions", {
        groupJid,
        senderJid,
        error: adminMentionError,
      });
    }

    return true;
  }

  if (adminMentionCooldown.isCoolingDown(groupJid, adminMentionNow)) {
    log("Suppressed admin mention reply during cooldown", {
      groupJid,
      senderJid,
      cooldownMinutes: config.adminMentionCooldownMinutes,
    });
    return true;
  }

  const replyText = pickAdminMentionReply();
  adminMentionCooldown.recordCooldown(groupJid, adminMentionNow);

  if (config.dryRun) {
    warn("Dry run: would respond to admin mention", {
      groupJid,
      senderJid,
      cooldownMinutes: config.adminMentionCooldownMinutes,
      wouldSendText: replyText,
    });
    return true;
  }

  try {
    await sock.sendMessage(groupJid, { text: replyText }, { quoted: msg });
    log("Responded to admin mention", {
      groupJid,
      senderJid,
      cooldownMinutes: config.adminMentionCooldownMinutes,
    });
  } catch (adminMentionError) {
    error("Failed to respond to admin mention", {
      groupJid,
      senderJid,
      error: adminMentionError,
    });
  }

  return true;
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
  context?: ModerationReplyContext,
): Promise<void> => {
  if (!mentionTargetJid || !MENTIONABLE_JID_REGEX.test(mentionTargetJid)) {
    const plainText = text.replace(/@\S+\s+-\s+/u, "").replace(/@\S+/u, "there");
    const sent = await sock.sendMessage(groupJid, { text: plainText }, quotedMessage ? { quoted: quotedMessage } : undefined);
    if (context) {
      recordModerationReplyContext(groupJid, sent?.key.id, context);
    }
    return;
  }

  log("Mention debug", {
    text,
    mentions: [mentionTargetJid],
    tokenInText: text.match(/@([^ ]+)/)?.[1] ?? null,
    jidUserPart: mentionTargetJid.split("@")[0] ?? null,
  });

  const sent = await sock.sendMessage(groupJid, {
    text,
    mentions: [mentionTargetJid],
  }, quotedMessage ? { quoted: quotedMessage } : undefined);
  if (context) {
    recordModerationReplyContext(groupJid, sent?.key.id, context);
  }
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

  if (reason === "social video (profile links only)") {
    return `Hey ${mentionLabel} - Instagram and TikTok video links are removed here. Please share the creator's profile page directly instead 🙏`;
  }

  if (reason === "url shortener") {
    return `Hey ${mentionLabel} - shortened links aren't allowed. Please share the full URL instead 🙏`;
  }

  if (reason === "bare profile handle or URL") {
    return `Hey ${mentionLabel} - this group only allows practical links like social profiles, music, accommodation, shopping, maps, bookings, or travel. If that was a social profile, please write it as @username, @/username, or share the full Instagram/TikTok/X profile URL. Bare dotted text can look like a website, so this one was removed without a strike. Future repeats may count as link violations 🙏`;
  }

  return `Hey ${mentionLabel} — please keep links practical: social profiles, music, accommodation, shopping, maps, bookings, or travel. For events, post at fete.outofofficecollective.co.uk 🙏`;
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

const appendCallGuardConsequenceText = (
  warningText: string,
  activeViolations?: number,
): string => {
  if (activeViolations === undefined) {
    return `${warningText}\n\nFurther call attempts may get you removed from the group.`;
  }

  const warningNumber = Math.min(activeViolations, config.groupCallGuardRemoveOn);
  const consequenceText = activeViolations >= config.groupCallGuardRemoveOn
    ? "You are being removed from the group for repeated call attempts."
    : `Warning ${warningNumber}/${config.groupCallGuardRemoveOn}. Another call attempt will get you removed from the group.`;

  return `${warningText}\n\n${consequenceText}`;
};

const getCallGuardWindowMs = (): number => config.groupCallGuardWindowHours * 60 * 60 * 1000;
const getCallGuardWarningCooldownMs = (): number => config.groupCallGuardWarningCooldownSeconds * 1000;
const getCallGuardRecentActivityTtlMs = (): number => config.groupCallGuardRecentActivityTtlMinutes * 60 * 1000;

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
  log("Loaded config", {
    ...config,
    ticketExchangeWebsiteBotSecret: config.ticketExchangeWebsiteBotSecret ? "[redacted]" : "",
  });
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

const getCallGuardWarningCooldownKey = (userId: string, groupJid: string): string => `${groupJid}:${userId}`;

const shouldSendCallGuardWarning = (userId: string, groupJid: string, nowMs: number): boolean => {
  const key = getCallGuardWarningCooldownKey(userId, groupJid);
  const lastSentAt = callGuardWarningLastSentByKey.get(key) ?? 0;
  if (nowMs - lastSentAt < getCallGuardWarningCooldownMs()) {
    return false;
  }

  callGuardWarningLastSentByKey.set(key, nowMs);
  return true;
};

const sweepCallGuardWarningCooldowns = (nowMs = Date.now()): void => {
  const cutoff = nowMs - getCallGuardWarningCooldownMs();
  for (const [key, lastSentAt] of callGuardWarningLastSentByKey) {
    if (lastSentAt <= cutoff) {
      callGuardWarningLastSentByKey.delete(key);
    }
  }
};

const normaliseCallGuardActivityKey = (value: string | null | undefined): string | null => {
  if (!value) {
    return null;
  }

  return normalizeJid(value);
};

const getCallGuardActivityKeys = (values: ReadonlyArray<string | null | undefined>): string[] =>
  Array.from(new Set(values.map(normaliseCallGuardActivityKey).filter((value): value is string => Boolean(value))));

const recordCallGuardRecentActivity = (
  keys: readonly string[],
  groupJid: string,
  nowMs = Date.now(),
): void => {
  for (const key of keys) {
    const groupActivity = callGuardRecentActivityByKey.get(key) ?? new Map<string, number>();
    groupActivity.set(groupJid, nowMs);
    callGuardRecentActivityByKey.set(key, groupActivity);
  }
};

const getCallGuardRecentGroupCandidates = (keys: readonly string[], nowMs = Date.now()): string[] => {
  const cutoff = nowMs - getCallGuardRecentActivityTtlMs();
  const candidates = new Set<string>();

  for (const key of keys) {
    const groupActivity = callGuardRecentActivityByKey.get(key);
    if (!groupActivity) {
      continue;
    }

    for (const [groupJid, lastActiveAt] of groupActivity.entries()) {
      if (lastActiveAt > cutoff && isGroupCallGuarded(groupJid)) {
        candidates.add(groupJid);
      } else if (lastActiveAt <= cutoff) {
        groupActivity.delete(groupJid);
      }
    }

    if (groupActivity.size === 0) {
      callGuardRecentActivityByKey.delete(key);
    }
  }

  return Array.from(candidates);
};

const sweepCallGuardRecentActivity = (nowMs = Date.now()): void => {
  const cutoff = nowMs - getCallGuardRecentActivityTtlMs();
  for (const [key, groupActivity] of callGuardRecentActivityByKey) {
    for (const [groupJid, lastActiveAt] of groupActivity) {
      if (lastActiveAt <= cutoff) {
        groupActivity.delete(groupJid);
      }
    }

    if (groupActivity.size === 0) {
      callGuardRecentActivityByKey.delete(key);
    }
  }
};

const recordCallGuardRecentActivityForUser = (
  user: ResolvedUser,
  extraAliases: ReadonlyArray<string | null | undefined>,
  groupJid: string,
  nowMs = Date.now(),
): void => {
  const keys = getCallGuardActivityKeys([
    user.userId,
    user.participantJid,
    ...user.knownAliases,
    ...extraAliases,
  ]);
  recordCallGuardRecentActivity(keys, groupJid, nowMs);
};

const getCallGuardActivityKeysForCall = (call: WACallEvent, caller: ResolvedUser): string[] =>
  getCallGuardActivityKeys([
    caller.userId,
    caller.participantJid,
    ...caller.knownAliases,
    call.from,
    call.chatId,
  ]);

const getCallGuardRecentGroupCandidatesForCall = (
  call: WACallEvent,
  caller: ResolvedUser,
  nowMs = Date.now(),
): string[] => getCallGuardRecentGroupCandidates(getCallGuardActivityKeysForCall(call, caller), nowMs);

const getInferredCallGuardGroupJidForCall = (
  call: WACallEvent,
  caller: ResolvedUser,
  nowMs = Date.now(),
): string | null => {
  const candidates = getCallGuardRecentGroupCandidatesForCall(call, caller, nowMs);
  return candidates.length === 1 ? candidates[0] ?? null : null;
};

const getCallGroupJid = (call: WACallEvent): string | null => {
  for (const candidate of [call.groupJid, call.chatId]) {
    if (candidate?.endsWith("@g.us")) {
      return candidate;
    }
  }

  return null;
};

const resolveCallCaller = async (sock: WASocket, call: WACallEvent): Promise<ResolvedUser | null> => {
  const callerJid = normalizeJid(call.from);
  return resolveUser({
    participantJid: callerJid,
    phoneJid: callerJid.endsWith("@s.whatsapp.net") ? callerJid : null,
    lidJid: callerJid.endsWith("@lid") ? callerJid : null,
    selfJids: getSelfJids(sock),
  });
};

const auditCallGuard = (
  call: WACallEvent,
  caller: ResolvedUser,
  action: CallGuardAuditAction,
  options: {
    groupJid?: string | null;
    inferred?: boolean;
    detail?: string | null;
    nowMs?: number;
  } = {},
): void => {
  logCallGuardAudit({
    callId: call.id,
    userId: caller.userId,
    rawCallerJid: call.from,
    groupJid: options.groupJid ?? null,
    inferred: options.inferred ?? false,
    action,
    detail: options.detail ?? null,
    createdAt: options.nowMs ?? Date.now(),
  });
};

const rejectCallForGuard = async (sock: WASocket, call: WACallEvent): Promise<void> => {
  try {
    await sock.rejectCall(call.id, call.from);
  } catch (rejectError) {
    warn("Failed to reject group call", {
      callId: call.id,
      callerJid: call.from,
      error: rejectError,
    });
  }
};

const sendCallGuardWarning = async (
  sock: WASocket,
  groupJid: string,
  warningText: string,
  mentionTargetJid: string,
  call: WACallEvent,
): Promise<boolean> => {
  try {
    await sendModerationMessage(sock, groupJid, warningText, mentionTargetJid);
    return true;
  } catch (warningError) {
    warn("Failed to send group call guard warning", {
      callId: call.id,
      groupJid,
      callerJid: call.from,
      error: warningError,
    });
    return false;
  }
};

const getCallGuardDmTargetJid = (caller: ResolvedUser | null, call: WACallEvent): string | null => {
  const candidates = [
    ...(caller?.knownAliases ?? []),
    caller?.participantJid ?? null,
    call.from,
    call.chatId,
  ]
    .map((jid) => jid ? normalizeJid(jid) : null)
    .filter((jid): jid is string => Boolean(jid));

  return (
    candidates.find((jid) => jid.endsWith("@s.whatsapp.net")) ??
    candidates.find((jid) => jid.endsWith("@lid")) ??
    null
  );
};

const sendCallGuardDmWarning = async (
  sock: WASocket,
  call: WACallEvent,
  caller: ResolvedUser | null,
): Promise<boolean> => {
  const dmTargetJid = getCallGuardDmTargetJid(caller, call);
  if (!dmTargetJid) {
    warn("Unable to find DM target for group call guard warning", {
      callId: call.id,
      callerJid: call.from,
      callerUserId: caller?.userId ?? null,
    });
    return false;
  }

  try {
    await sock.sendMessage(dmTargetJid, {
      text: "Calls aren't allowed in the groups managed by Fete Bot. Don't do that again. 🙏🏾\n\nFurther call attempts may get you removed from the group.",
    });
    warn("Sent DM warning for group call without group JID", {
      callId: call.id,
      callerJid: call.from,
      callerUserId: caller?.userId ?? null,
      dmTargetJid,
    });
    return true;
  } catch (dmError) {
    warn("Failed to send DM warning for group call without group JID", {
      callId: call.id,
      callerJid: call.from,
      callerUserId: caller?.userId ?? null,
      dmTargetJid,
      error: dmError,
    });
    return false;
  }
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

  if (hasHandledCallOfferId(call.id)) {
    return;
  }

  const groupJid = getCallGroupJid(call);
  const caller = await resolveCallCaller(sock, call);
  if (!caller) {
    warn("Unable to resolve group call caller", {
      callId: call.id,
      callerJid: call.from,
      groupJid,
    });
  }

  if (!groupJid && shouldRejectUnknownGroupCall(call)) {
    markHandledCallOfferId(call.id);

    if (config.dryRun) {
      warn("Dry run: would reject group call without group JID", {
        callId: call.id,
        chatId: call.chatId,
        callerJid: call.from,
        isVideo: call.isVideo,
      });
      return;
    }

    await rejectCallForGuard(sock, call);
    if (caller) {
      auditCallGuard(call, caller, "reject", { nowMs: Date.now() });
    }
    warn("Rejected group call without group JID", {
      callId: call.id,
      chatId: call.chatId,
      callerJid: call.from,
      isVideo: call.isVideo,
    });

    if (caller) {
      const nowMs = Date.now();
      const inferredGroupJid = getInferredCallGuardGroupJidForCall(call, caller, nowMs);
      if (inferredGroupJid) {
        if (shouldSendCallGuardWarning(caller.userId, inferredGroupJid, nowMs)) {
          const warned = await sendCallGuardWarning(
            sock,
            inferredGroupJid,
            appendCallGuardConsequenceText(getGroupCallWarningText(caller.participantJid ?? normalizeJid(call.from))),
            getMentionTargetJid(caller.participantJid ?? normalizeJid(call.from)),
            call,
          );
          if (warned) {
            auditCallGuard(call, caller, "warn", {
              groupJid: inferredGroupJid,
              inferred: true,
              detail: "recent_activity_inference",
              nowMs,
            });
            warn("Warned inferred group for call offer without group JID", {
              callId: call.id,
              callerJid: call.from,
              callerUserId: caller.userId,
              inferredGroupJid,
            });
          }
        }
      } else {
        const activityKeys = getCallGuardActivityKeysForCall(call, caller);
        const candidates = getCallGuardRecentGroupCandidatesForCall(call, caller, nowMs);
        warn("Could not infer a unique group for call offer without group JID", {
          callId: call.id,
          callerJid: call.from,
          callerUserId: caller.userId,
          activityKeys,
          recentGroupCandidates: candidates,
          reason: candidates.length === 0 ? "no_recent_group_activity" : "ambiguous_recent_group_activity",
        });
        auditCallGuard(call, caller, "infer_skip", {
          inferred: true,
          detail: candidates.length === 0 ? "no_recent_group_activity" : `ambiguous_recent_group_activity:${candidates.join(",")}`,
          nowMs,
        });
        const dmWarned = await sendCallGuardDmWarning(sock, call, caller);
        if (dmWarned) {
          auditCallGuard(call, caller, "warn", {
            inferred: true,
            detail: "dm_fallback",
            nowMs,
          });
        }
      }
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

  markHandledCallOfferId(call.id);
  const callerMentionJid = caller?.participantJid ?? normalizeJid(call.from);
  const mentionTargetJid = getMentionTargetJid(callerMentionJid);

  if (config.dryRun) {
    warn("Dry run: would reject group call and enforce call guard", {
      callId: call.id,
      groupJid,
      callerJid: call.from,
      isVideo: call.isVideo,
      wouldSendText: appendCallGuardConsequenceText(getGroupCallWarningText(callerMentionJid)),
    });
    return;
  }

  await rejectCallForGuard(sock, call);
  if (!caller) {
    return;
  }

  const nowMs = Date.now();
  auditCallGuard(call, caller, "reject", { groupJid, nowMs });
  const activeViolations = addCallViolationAndCountActive(
    caller.userId,
    groupJid,
    call.id,
    nowMs,
    getCallGuardWindowMs(),
  );

  if (shouldSendCallGuardWarning(caller.userId, groupJid, nowMs)) {
    const warningText = appendCallGuardConsequenceText(getGroupCallWarningText(callerMentionJid), activeViolations);
    const warned = await sendCallGuardWarning(sock, groupJid, warningText, mentionTargetJid, call);
    if (warned) {
      auditCallGuard(call, caller, "warn", { groupJid, nowMs });
    }
  }

  if (activeViolations >= config.groupCallGuardRemoveOn) {
    auditCallGuard(call, caller, "remove_attempt", {
      groupJid,
      detail: `active_violations:${activeViolations}`,
      nowMs,
    });

    const liveParticipantJid = findParticipantJidForUser(caller.userId, discoveredGroupMetadata.get(groupJid));
    if (!liveParticipantJid) {
      auditCallGuard(call, caller, "remove_fail", {
        groupJid,
        detail: "participant_not_found",
        nowMs,
      });
      return;
    }

    try {
      await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
      auditCallGuard(call, caller, "remove_ok", {
        groupJid,
        detail: `active_violations:${activeViolations}`,
        nowMs,
      });
      warn("Removed caller for repeated group call attempts", {
        callId: call.id,
        callerJid: call.from,
        groupJid,
        activeViolations,
      });
    } catch (removeError) {
      auditCallGuard(call, caller, "remove_fail", {
        groupJid,
        detail: removeError instanceof Error ? removeError.message : String(removeError),
        nowMs,
      });
      error("Failed to remove caller for repeated group call attempts", {
        callId: call.id,
        callerJid: call.from,
        groupJid,
        activeViolations,
        error: removeError,
      });
    }
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

const syncObservedPhoneLidIdentity = async (
  phoneJid: string | null | undefined,
  lidJid: string | null | undefined,
  pushName: string | null,
  sock: WASocket,
): Promise<void> => {
  if (!phoneJid || !lidJid) {
    return;
  }

  try {
    recordLidMapping(phoneJid, lidJid);
    const resolved = await resolveUser({
      participantJid: lidJid,
      phoneJid,
      lidJid,
      pushName,
      selfJids: getSelfJids(sock),
      reason: "metadata_sync",
    });
    const merged = await mergeUserAliases([phoneJid, lidJid], getSelfJids(sock), "metadata_sync");
    log("identity.observed_phone_lid_synced", {
      phoneJid,
      lidJid,
      resolvedUserId: resolved?.userId ?? null,
      mergedUserId: merged?.userId ?? null,
      mergedFrom: merged?.mergedFrom ?? [],
    });
  } catch (mappingError) {
    warn("Failed to sync observed phone/lid identity", {
      phoneJid,
      lidJid,
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

const resolveDirectSenderFromMetadataJid = async (
  remoteJid: string,
  pushName: string | null,
  sock: WASocket,
): Promise<ResolvedUser | null> => {
  const normalizedRemoteJid = normalizeJid(remoteJid);
  for (const metadata of discoveredGroupMetadata.values()) {
    for (const participant of metadata.participants) {
      const participantAliases = [
        participant.id ? normalizeJid(participant.id) : null,
        participant.lid ? normalizeJid(participant.lid) : null,
        participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
      ].filter((alias): alias is string => Boolean(alias));

      if (!participantAliases.includes(normalizedRemoteJid)) {
        continue;
      }

      await syncLidMappingIdentity(participant.lid, participant.phoneNumber, sock);
      return await resolveUser({
        participantJid: participant.id ?? remoteJid,
        phoneJid: participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
        lidJid: participant.lid ?? (remoteJid.endsWith("@lid") ? remoteJid : null),
        pushName,
        selfJids: getSelfJids(sock),
        reason: "metadata_sync",
      });
    }
  }

  return null;
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

const resolveGroupSenderFromMetadata = async (
  sender: ResolvedUser,
  groupJid: string,
  pushName: string | null,
  sock: WASocket,
): Promise<ResolvedUser> => {
  const metadata = discoveredGroupMetadata.get(groupJid);
  if (!metadata) {
    return sender;
  }

  const senderAliases = new Set(
    [sender.participantJid, ...sender.knownAliases]
      .filter((alias): alias is string => Boolean(alias))
      .map((alias) => normalizeJid(alias)),
  );

  const participant = metadata.participants.find((candidate) => {
    const candidateAliases = [
      candidate.id ? normalizeJid(candidate.id) : null,
      candidate.lid ? normalizeJid(candidate.lid) : null,
      candidate.phoneNumber ? parseToJid(candidate.phoneNumber) : null,
    ].filter((alias): alias is string => Boolean(alias));

    return candidateAliases.some((alias) => senderAliases.has(alias));
  });

  if (!participant) {
    return sender;
  }

  await syncLidMappingIdentity(participant.lid, participant.phoneNumber, sock);
  const resolved = await resolveUser({
    participantJid: participant.id ?? sender.participantJid,
    phoneJid: participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
    lidJid: participant.lid ?? (sender.participantJid?.endsWith("@lid") ? sender.participantJid : null),
    pushName,
    selfJids: getSelfJids(sock),
    reason: "metadata_sync",
  });

  return resolved ?? sender;
};

const sendIgnoredGroupCommandDiagnostic = async (
  sock: WASocket,
  replyJid: string | null,
  groupJid: string,
  sender: ResolvedUser,
  text: string,
  phoneJid: string | null,
  lidJid: string | null,
  pushName: string | null,
): Promise<void> => {
  if (!replyJid) {
    return;
  }

  try {
    await sock.sendMessage(replyJid, {
      text: `⛔ You're not authorised to use Fete Bot commands in this group.

Command: ${text.trim().split(/\s+/)[0] ?? "unknown"}
Group: ${groupJid}
User ID: ${sender.userId}
Participant JID: ${sender.participantJid ?? "unknown"}
Phone JID: ${phoneJid ?? "unknown"}
LID JID: ${lidJid ?? "unknown"}
Known aliases: ${sender.knownAliases.length > 0 ? sender.knownAliases.join(", ") : "none"}
Push name: ${pushName ?? "unknown"}

If this is you, make sure one of those aliases is in OWNER_JIDS or added with !addmod.`,
    });
  } catch (diagnosticError) {
    warn("Failed to send ignored group command diagnostic", {
      groupJid,
      replyJid,
      senderJid: sender.participantJid,
      error: diagnosticError,
    });
  }
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
      log("Discovered group", { jid, subject: metadata.subject });

      if (!isManagedGroup(jid)) {
        continue;
      }

      discoveredGroupMetadata.set(jid, metadata);
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
  phoneJid: string | null,
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

    const websitePromptSuppressed = isQuietSwitchEnabled() || getDebugRedirectSwitchState().enabled;
    if (websitePromptSuppressed) {
      log("spotlight.website_prompt.skipped_suppressed", {
        pendingId: queued.id,
        groupJid,
        senderJid,
        senderUserId,
      });
    } else {
      const userPromptAllowed = shouldSendSpotlightWebsitePrompt(
        senderUserId,
        config.ticketExchangeWebsiteSpotlightPromptCooldownDays,
      );
      const groupPromptAllowed = shouldSendSpotlightWebsiteGroupPrompt(
        groupJid,
        SPOTLIGHT_WEBSITE_GROUP_PROMPT_COOLDOWN_HOURS,
      );
      const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
      const mentionLabel = formatMentionLabel(senderJid, getPushName(msg), phoneJid);

      if (userPromptAllowed) {
        const promptTargets = getKnownDirectMessageTargets(
          senderJid,
          getUserAliases(senderUserId).map((alias) => alias.alias),
        );
        let promptSent = false;
        let lastPromptError: unknown = null;
        for (const [targetIndex, targetJid] of promptTargets.entries()) {
          try {
            log("spotlight.website_prompt.dm_target_attempt", {
              pendingId: queued.id,
              groupJid,
              senderJid,
              targetJid,
              targetIndex: targetIndex + 1,
              targetCount: promptTargets.length,
              senderUserId,
            });
            const sent = await sock.sendMessage(targetJid, {
              text: buildSpotlightWebsitePromptText(config.ticketExchangeWebsiteBaseUrl),
            });
            const directMessageId = sent?.key.id;
            if (!directMessageId) {
              throw new Error("WhatsApp send returned without a message id");
            }
            trackOutgoingDirectMessage(directMessageId, {
              purpose: "spotlight_website_prompt",
              pendingId: queued.id,
              userId: senderUserId,
              targetJid,
              remoteJid: sent.key.remoteJid,
              fallback: targetIndex > 0,
            });
            recordSpotlightWebsitePromptSent(senderUserId);
            promptSent = true;
            log("spotlight.website_prompt.dm_sent", {
              pendingId: queued.id,
              groupJid,
              senderJid,
              targetJid,
              senderUserId,
              messageId: directMessageId,
              remoteJid: sent.key.remoteJid,
            });
            break;
          } catch (targetError) {
            lastPromptError = targetError;
            warn("spotlight.website_prompt.dm_target_failed", {
              pendingId: queued.id,
              groupJid,
              senderJid,
              targetJid,
              senderUserId,
              error: targetError,
            });
          }
        }

        if (!promptSent) {
          warn("spotlight.website_prompt.dm_send_failed", {
            pendingId: queued.id,
            groupJid,
            senderJid,
            targets: promptTargets,
            senderUserId,
            error: lastPromptError ?? new Error("No usable spotlight website prompt target"),
          });
        }
      }

      if (groupPromptAllowed) {
        try {
          const sent = await sock.sendMessage(
            groupJid,
            {
              text: buildSpotlightWebsiteGroupPromptText(mentionLabel, config.ticketExchangeWebsiteBaseUrl),
              mentions: mentionTargetJid ? [mentionTargetJid] : [],
            },
            { quoted: msg },
          );
          recordSpotlightWebsiteGroupPromptSent(groupJid);
          log("spotlight.website_prompt.group_sent", {
            pendingId: queued.id,
            groupJid,
            senderJid,
            senderUserId,
            mentionTargetJid: mentionTargetJid || null,
            messageId: sent?.key.id ?? null,
          });
        } catch (promptError) {
          warn("spotlight.website_prompt.group_send_failed", {
            pendingId: queued.id,
            groupJid,
            senderJid,
            mentionTargetJid: mentionTargetJid || null,
            senderUserId,
            error: promptError,
          });
        }
      }

      if (!userPromptAllowed || !groupPromptAllowed) {
        log("spotlight.website_prompt.skipped_cooldown", {
          pendingId: queued.id,
          groupJid,
          senderJid,
          senderUserId,
          groupCooldown: !groupPromptAllowed,
          userCooldown: !userPromptAllowed,
          groupCooldownHours: SPOTLIGHT_WEBSITE_GROUP_PROMPT_COOLDOWN_HOURS,
          userCooldownDays: config.ticketExchangeWebsiteSpotlightPromptCooldownDays,
        });
      }
    }
  }
};

const cancelPendingSpotlightIfSold = async (
  sock: WASocket,
  msg: WAMessage,
  groupJid: string,
  senderUserId: string,
  senderJid: string,
  text: string,
): Promise<boolean> => {
  if (!config.ticketMarketplaceGroupJids.includes(groupJid) || !isSpotlightSoldNotice(text)) {
    return false;
  }

  if (config.dryRun) {
    if (hasPendingSpotlightForSenderInGroup(groupJid, senderUserId, "selling")) {
      log("Dry run: would cancel pending spotlight after sold notice", {
        groupJid,
        senderJid,
      });
      return true;
    }

    return false;
  }

  const cancelledCount = cancelPendingSpotlightsForSenderInGroup(groupJid, senderUserId, "sold", undefined, "selling");
  if (cancelledCount === 0) {
    return false;
  }

  log("spotlight.cancelled.sold", {
    groupJid,
    senderJid,
    sourceMsgId: msg.key.id ?? null,
    cancelledCount,
  });

  try {
    await sock.sendMessage(groupJid, {
      react: {
        text: config.ticketSpotlightReactionEmoji,
        key: msg.key,
      },
    });
    log("spotlight.sold_reacted", {
      groupJid,
      senderJid,
      sourceMsgId: msg.key.id ?? null,
      reactionEmoji: config.ticketSpotlightReactionEmoji,
    });
  } catch (reactionError) {
    warn("spotlight.sold_reaction_failed", {
      groupJid,
      senderJid,
      sourceMsgId: msg.key.id ?? null,
      error: reactionError,
    });
  }

  return true;
};

export const handleMessage = async (
  sock: WASocket,
  msg: WAMessage,
): Promise<void> => {
  try {
    if (!msg.message) {
      return;
    }

    const remoteJid = msg.key.remoteJid;
    if (!remoteJid) {
      return;
    }

    const text = extractMessageText(msg);
    const isDirectChat = isUserChatJid(remoteJid);
    const isDirectCommand = isDirectCommandCandidate(remoteJid, text);

    if (msg.key.fromMe) {
      if (isDirectCommand) {
        log("Ignored own direct command message", {
          remoteJid,
          messageId: msg.key.id ?? null,
          hasText: text.length > 0,
          textLength: text.length,
          ...maybeLogTextField(text),
        });
      }
      if (isDirectChat) {
        await handleCleanupDmBackfillMarker(sock, remoteJid, msg, text);
      }
      return;
    }

    const selfJids = getSelfJids(sock);
    const { senderJid, phoneNumber, lidJid } = extractAllIdentifiers(msg);
    const rawPhoneJid = getPhoneJid(phoneNumber);
    const observedPhoneJid = rawPhoneJid ?? getPhoneAliasFromSender(senderJid);
    const phoneJid = observedPhoneJid;
    await syncObservedPhoneLidIdentity(observedPhoneJid, lidJid, getPushName(msg), sock);

    if (isDirectCommand) {
      log("direct.command.received", {
        remoteJid,
        senderJid: senderJid || null,
        phoneNumber,
        phoneJid,
        rawPhoneJid,
        lidJid,
        participantJid: msg.key.participant ?? null,
        participantPn: (msg.key as { participantPn?: string | null }).participantPn ?? null,
        senderPn: (msg.key as { senderPn?: string | null }).senderPn ?? null,
        fromMe: msg.key.fromMe,
        pushName: getPushName(msg),
        hasText: text.length > 0,
        textLength: text.length,
        remoteJidClassification: isDirectChat ? "user" : "unknown_direct_candidate",
        ...maybeLogTextField(text),
      });
    }

    const directMetadataSender = isDirectCommand
      ? await resolveDirectSenderFromMetadataJid(remoteJid, getPushName(msg), sock)
      : null;
    const sender = await resolveUser({
      participantJid: senderJid || null,
      phoneJid: observedPhoneJid,
      lidJid,
      pushName: getPushName(msg),
      selfJids,
    }) ?? directMetadataSender ?? (isDirectCommand
      ? await resolveUser({
          participantJid: remoteJid,
          phoneJid: remoteJid.endsWith("@s.whatsapp.net") ? remoteJid : null,
          lidJid: remoteJid.endsWith("@lid") ? remoteJid : null,
          pushName: getPushName(msg),
          selfJids,
        })
      : null);

    if (!sender) {
      if (isDirectCommand) {
        await sock.sendMessage(remoteJid, {
          text: `⛔ You're not authorised to use Fete Bot commands. Ignoring this command.

Raw identity:
Remote JID: ${remoteJid}
Sender JID: ${senderJid || "unknown"}
Phone JID: ${phoneJid ?? "unknown"}
Observed phone JID: ${observedPhoneJid ?? "unknown"}
Phone number: ${phoneNumber ?? "unknown"}
LID JID: ${lidJid ?? "unknown"}
Push name: ${getPushName(msg) ?? "unknown"}`,
        });
      } else if (isDirectChat) {
        await maybeSendDirectChatAutoresponse(sock, remoteJid, msg, text);
      }
      return;
    }

    if (isDirectCommand) {
      log("direct.command.identity.resolved", {
        remoteJid,
        userId: sender.userId,
        shortId: sender.shortId,
        participantJid: sender.participantJid,
        knownAliases: sender.knownAliases,
      });
    }

    if (isDirectCommand || isDirectChat) {
      const directSenderFromGroups = await resolveDirectSenderFromKnownGroups(sender, remoteJid, getPushName(msg), sock);
      const directSender = await resolveDirectSenderFromOwnerAliases(directSenderFromGroups, selfJids);
      let cleanupHandled = false;
      if (!isDirectCommand) {
        cleanupHandled = await recordCleanupInteraction(sock, directSender, remoteJid, msg, text, true);
      }
      if (text) {
        await handleAuthorisedCommand(
          isDirectCommand ? buildDirectCommandReplySocket(sock, remoteJid, msg) : sock,
          directSender,
          text,
          getQuotedText(msg.message),
          config,
          discoveredGroups,
          discoveredGroupMetadata,
          selfJids,
        );
      }
      if (!isDirectCommand && !cleanupHandled) {
        await maybeSendDirectChatAutoresponse(sock, remoteJid, msg, text);
      }
      return;
    }

    if (!sender.participantJid) {
      return;
    }

    const groupJid = remoteJid;
    if (!groupJid.endsWith("@g.us")) {
      return;
    }

    const groupSender = await resolveGroupSenderFromMetadata(sender, groupJid, getPushName(msg), sock);
    const liveSenderJid = groupSender.participantJid ?? sender.participantJid;
    if (!liveSenderJid) {
      return;
    }
    const canonicalSenderAlias = groupSender.knownAliases.find((alias) => alias.endsWith("@s.whatsapp.net")) ?? observedPhoneJid ?? liveSenderJid;

    if (config.logAllowedMessages) {
      log("message.seen", {
        groupJid,
        senderJid: canonicalSenderAlias,
        lidJid,
        pushName: getPushName(msg),
        hasText: text.length > 0,
        textLength: text.length,
        ...maybeLogTextField(text),
      });
    }

    if (!isManagedGroup(groupJid)) {
      return;
    }

    recordCallGuardRecentActivityForUser(
      groupSender,
      [senderJid, liveSenderJid, lidJid, observedPhoneJid, canonicalSenderAlias],
      groupJid,
    );

    if (config.ticketMarketplaceGroupJids.includes(groupJid)) {
      recordTicketMarketplaceRuleReminderActivity(groupJid);
    }

    await recordCleanupInteraction(sock, groupSender, groupJid, msg, text, false);

    if (text) {
      const handledGroupCommand = await handleGroupCommand(
        sock,
        groupSender,
        groupJid,
        text,
        getQuotedParticipant(msg.message),
        getQuotedText(msg.message),
        getQuotedMessageKey(msg.message, groupJid),
        config,
        discoveredGroups,
        discoveredGroupMetadata,
        selfJids,
      );

      if (handledGroupCommand) {
        return;
      }
    }

    if (isGroupShhEnabled(groupJid)) {
      if (!config.dryRun) {
        await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
      }

      logAction({
        timestamp: new Date().toISOString(),
        group_jid: groupJid,
        user_id: groupSender.userId,
        participant_jid: liveSenderJid,
        push_name: getPushName(msg),
        message_text: text || null,
        url_found: null,
        action: config.dryRun ? "DRY_RUN" : "DELETED",
        reason: "group shh",
      });
      warn(config.dryRun ? "Dry run: would delete message during group shh" : "Deleted message during group shh", {
        groupJid,
        senderJid: canonicalSenderAlias,
        lidJid,
        hasText: text.length > 0,
      });
      return;
    }

    const senderIsProtected = isProtectedGroupMember(
      groupSender.userId,
      groupSender.knownAliases,
      groupJid,
      config,
      discoveredGroupMetadata,
    );

    if (senderIsProtected) {
      if (text) {
        await maybeSendAdminSummonReply(sock, msg, groupJid, canonicalSenderAlias, text, selfJids);
      }

      return;
    }

    if (text.startsWith("!")) {
      warn("Ignored in-group command from unauthorised sender", {
        groupJid,
        senderJid: liveSenderJid,
        phoneJid,
        lidJid,
        pushName: getPushName(msg),
        command: text.trim().split(/\s+/)[0] ?? "",
        ...maybeLogTextField(text),
      });
      await sendIgnoredGroupCommandDiagnostic(
        sock,
        groupSender.participantJid,
        groupJid,
        groupSender,
        text,
        phoneJid,
        lidJid,
        getPushName(msg),
      );
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
    await maybeSendAdminSummonReply(sock, msg, groupJid, canonicalSenderAlias, text, selfJids);

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

      const soldSpotlightHandled = await cancelPendingSpotlightIfSold(
        sock,
        msg,
        groupJid,
        sender.userId,
        canonicalSenderAlias,
        text,
      );
      if (soldSpotlightHandled) {
        return;
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
        const shouldDeleteTicketMarketplaceMessage = isTicketMarketplaceDeletionEnabled() && ticketDecision.action !== "review";
        const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
        const mentionLabel = formatMentionLabel(senderJid, getPushName(msg), phoneJid);
        const marketplaceName = config.ticketMarketplaceGroupName;
        const replyText = ticketDecision.action === "redirect_buying"
          ? buildTicketExchangeRedirectText({
            action: "redirect_buying",
            mentionLabel,
            marketplaceName,
            baseUrl: config.ticketExchangeWebsiteBaseUrl,
          })
          : ticketDecision.action === "redirect_selling"
            ? buildTicketExchangeRedirectText({
              action: "redirect_selling",
              mentionLabel,
              marketplaceName,
              baseUrl: config.ticketExchangeWebsiteBaseUrl,
            })
            : ticketDecision.action === "require_price"
              ? `Hey ${mentionLabel} - ticket sale posts must include a price, or say face value / FV.`
              : buildTicketExchangeRedirectText({
                action: "review",
                mentionLabel,
                marketplaceName,
                baseUrl: config.ticketExchangeWebsiteBaseUrl,
              });
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
            await sendModerationMessage(sock, groupJid, replyText, mentionTargetJid, msg, {
              sourceGroupJid: groupJid,
              sourceMsgId: msg.key.id ?? null,
              sourceText: text,
              reason: ticketDecision.reason,
            });
            ticketMarketplaceReplyCooldown.record(groupJid, sender.userId, cooldownNow);
          }

          if (ticketDecision.action === "review") {
            upsertReviewQueueEntry(
              sender.userId,
              groupJid,
              getPushName(msg) || null,
              ticketDecision.reason ?? "ticket_marketplace_review",
              text,
            );
            logAction({
              ...logEntry,
              action: "WARN",
            });
          } else if (!replyCoolingDown || shouldDeleteTicketMarketplaceMessage) {
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
        phoneJid,
        text,
        ticketDecision,
      );
    }

    if (config.logAllowedMessages) {
      log("message.allowed", {
        groupJid,
        senderJid: canonicalSenderAlias,
        lidJid,
        pushName: getPushName(msg),
        textLength: text.length,
        ...maybeLogTextField(text),
      });
    }

    const moderationResult = isLinkGraceActive(sender.userId, groupJid)
      ? { found: false }
      : containsDisallowedUrl(text);
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
        const reason = moderationResult.reason ?? "unknown";
        const shouldRemoveWithoutStrike =
          reason === "social video (profile links only)" ||
          (reason === "bare profile handle or URL" &&
            getDeletedMessageLogCount(sender.userId, groupJid, reason) === 0);
        const strikeCount = shouldRemoveWithoutStrike
          ? 0
          : addStrike(
              sender.userId,
              groupJid,
              reason,
              randomUUID(),
            );
        await sendModerationMessage(
          sock,
          groupJid,
          shouldRemoveWithoutStrike
            ? warningText
            : appendStrikeWarning(warningText, strikeCount),
          mentionTargetJid,
          msg,
          {
            sourceGroupJid: groupJid,
            sourceMsgId: msg.key.id ?? null,
            sourceText: text,
            reason,
          },
        );

        if (strikeCount >= 3) {
          upsertReviewQueueEntry(
            sender.userId,
            groupJid,
            pushName,
            reason,
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
          await sendModerationMessage(sock, groupJid, flaggedText, mentionTargetJid, undefined, {
            sourceGroupJid: groupJid,
            sourceMsgId: msg.key.id ?? null,
            sourceText: text,
            reason,
          });
          await notifyOwnersOfStrikeThree(
            sock,
            canonicalSenderAlias,
            groupJid,
            pushName,
            reason,
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
          msg,
          {
            sourceGroupJid: groupJid,
            sourceMsgId: msg.key.id ?? null,
            sourceText: text,
            reason: spamResult.reason,
          },
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
          await sendModerationMessage(sock, groupJid, flaggedText, mentionTargetJid, undefined, {
            sourceGroupJid: groupJid,
            sourceMsgId: msg.key.id ?? null,
            sourceText: text,
            reason: spamResult.reason,
          });
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
        await sendModerationMessage(sock, groupJid, spamWarningText, mentionTargetJid, msg, {
          sourceGroupJid: groupJid,
          sourceMsgId: msg.key.id ?? null,
          sourceText: text,
          reason: spamResult.reason,
        });
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
  if (!healthServerStarted && !healthServerErrored) {
    healthServer.listen(healthPort, () => {
      log(`Health endpoint listening on port ${healthPort}`);
    });
    healthServerStarted = true;
  }
  initDb();
  await loadLidMappings();
  purgeExpiredStrikes();
  purgeExpiredMutes();
  purgeExpiredCallViolations(getCallGuardWindowMs());
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
  if (!callViolationPurgeTimer) {
    callViolationPurgeTimer = setInterval(() => {
      purgeExpiredCallViolations(getCallGuardWindowMs());
    }, 60 * 60 * 1000);
    callViolationPurgeTimer.unref();
  }
  if (!handledCallSweepTimer) {
    handledCallSweepTimer = setInterval(() => {
      sweepHandledCallOfferIds();
      sweepCallGuardRecentActivity();
      sweepCallGuardWarningCooldowns();
    }, 5 * 60 * 1000);
    handledCallSweepTimer.unref();
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
    syncFullHistory: false,
    shouldSyncHistoryMessage: () => false,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
    logger: pino({ level: "silent" }),
  });
  installSafeSendGuard(sock, getSafeSendOptionsFromEnv());
  activeSocket = sock;
  refreshSelfJids(sock);

  const pairingPhoneDigits = getPairingPhoneDigits(config.whatsappPairingPhoneNumber);
  const shouldRequestPairingCode = shouldRequestWhatsAppPairingCode(state.creds, pairingPhoneDigits);
  if (!shouldRequestPairingCode && pairingPhoneDigits && !state.creds.registered) {
    log("Skipping WhatsApp pairing code request because an existing linked account identity is present.", {
      me: state.creds.me ?? null,
    });
  }
  if (!shouldRequestPairingCode && config.whatsappPairingPhoneNumber && !pairingPhoneDigits) {
    warn("WHATSAPP_PAIRING_PHONE_NUMBER is set but could not be parsed. Use international format, for example +447700900000.");
  }
  if (shouldRequestPairingCode && pairingPhoneDigits && !pairingCodeRequested) {
    const pairingDigits = pairingPhoneDigits;
    pairingCodeRequested = true;
    setTimeout(() => {
      void (async () => {
        try {
          const code = await sock.requestPairingCode(pairingDigits);
          const formattedCode = formatPairingCode(code);
          log(`WhatsApp pairing code requested: ${formattedCode}. In WhatsApp, choose Link with phone number instead.`, {
            pairingCode: formattedCode,
          });
        } catch (pairingError) {
          pairingCodeRequested = false;
          error("Failed to request WhatsApp pairing code", pairingError);
        }
      })();
    }, 3_000);
  }

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
      qrEventsSeen += 1;
      const maxQrEvents = config.whatsappQrMaxEvents;
      const qrLimitEnabled = maxQrEvents > 0;

      if (qrLimitEnabled && qrEventsSeen > maxQrEvents) {
        if (!qrLimitShutdownScheduled) {
          qrLimitShutdownScheduled = true;
          warn("WhatsApp QR event limit exceeded; shutting down to avoid repeated link-device attempts.", {
            qrEventsSeen,
            maxQrEvents,
          });
          setTimeout(() => {
            void shutdown("WHATSAPP_QR_MAX_EVENTS");
          }, 500);
        }
        return;
      }

      log("QR received. Scan it with the WhatsApp Business account you want to use.");
      log("=== QR RAW STRING (paste into any QR generator) ===");
      process.stdout.write(`${qr}\n`);
      log("=== END RAW STRING ===");

      const qrImageUrl = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
      log(`QR image URL: ${qrImageUrl}`);

      QRCode.toString(qr, { type: "terminal", small: false, margin: 2 }, (err: Error | null | undefined, code: string) => {
        if (err) {
          warn("Failed to render terminal QR code.", err);
          return;
        }

        const paddedCode = code
          .split("\n")
          .map((line: string) => `.${line}`)
          .join("\n");
        process.stdout.write(`\n${paddedCode}\n`);
      });

      if (qrLimitEnabled && qrEventsSeen >= maxQrEvents && !qrLimitShutdownScheduled) {
        qrLimitShutdownScheduled = true;
        warn("WhatsApp QR event limit reached; shutting down after this QR to avoid repeated link-device attempts.", {
          qrEventsSeen,
          maxQrEvents,
        });
        setTimeout(() => {
          void shutdown("WHATSAPP_QR_MAX_EVENTS");
        }, 2_000);
      }
    }

    if (connection === "open") {
      reconnecting = false;
      reconnectAttempts = 0;
      qrEventsSeen = 0;
      qrLimitShutdownScheduled = false;
      refreshSelfJids(sock);
      log("Bot connected");
      scheduleWhatsAppAuthBackup();
      void (async () => {
        await sendStartupOwnerAwakeMessages(sock);
        await runDmDebugSanitySend(sock);
        await listDiscoveredGroups(sock);
        await enforceGlobalBans(sock);
        await runStartupHealthCheck(sock, config, discoveredGroupMetadata);
        startSpotlightScheduler(sock, config, getEffectiveTicketSpotlightTargetJids);
        startTicketMarketplaceRuleReminderScheduler(sock, config);
        startWebsiteTicketExchangeAnnouncementScheduler(sock, config);
        startAnnouncementScheduler(sock, config, () => discoveredGroups);
        startCleanupScheduler(sock, config, {
          onDmSendAccepted: (event) => {
            trackOutgoingDirectMessage(event.messageId, {
              purpose: "cleanup_dm",
              targetJid: event.targetJid,
              campaignId: event.campaignId,
              userId: event.userId,
              remoteJid: event.remoteJid,
              fallback: false,
            });
          },
        });
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
      messageQueue.splice(0, messageQueue.length);
      stopSpotlightScheduler();
      stopTicketMarketplaceRuleReminderScheduler();
      stopWebsiteTicketExchangeAnnouncementScheduler();
      stopAnnouncementScheduler();
      stopCleanupScheduler();
      clearAuthBackupRetryTimer();

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
        cleanupSocket(sock);
        pairingCodeRequested = false;

        if (pairingPhoneDigits) {
          warn("WhatsApp logged the bot out. Clearing auth folder and restarting pairing.", {
            authFolder,
            statusCode,
          });
          try {
            rmSync(authFolder, { recursive: true, force: true });
            mkdirSync(authFolder, { recursive: true });
          } catch (authCleanupError) {
            error("Failed to clear WhatsApp auth folder after logout.", authCleanupError);
            warn("Bot is staying online for health/SSH while waiting for WhatsApp re-pair.");
            return;
          }

          setTimeout(() => {
            void startBot();
          }, 1_000);
          return;
        }

        error(`WhatsApp logged the bot out. Remove the auth folder (${authFolder}) and pair again.`, { statusCode });
        warn("Bot is staying online for health/SSH while waiting for WhatsApp re-pair.");
        return;
      }

      const delay = Math.min(Math.max(reconnectAttempts, 1) * 2000, 30_000);
      reconnectAttempts += 1;

      warn("Connection closed, reconnecting with backoff", { statusCode, delay, reconnectAttempts });
      cleanupSocket(sock);

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
      enqueueMessage(socketInstanceId, sock, message);
    }
  });

  sock.ev.on("messages.update", (updates) => {
    for (const messageUpdate of updates) {
      const messageId = messageUpdate.key.id ?? null;
      if (!messageId) {
        continue;
      }

      const deliveryStatus = messageUpdate.update.status ?? null;
      if (isDeliveredMessageStatus(deliveryStatus)) {
        const deliveredCleanup = markCleanupDmDeliveredByMessageId(messageId, Date.now());
        if (deliveredCleanup) {
          log("cleanup.dm_delivery_confirmed", {
            messageId,
            status: deliveryStatus,
            remoteJid: messageUpdate.key.remoteJid ?? null,
            fromMe: messageUpdate.key.fromMe ?? null,
            participant: messageUpdate.key.participant ?? null,
            ...deliveredCleanup,
          });
        }
      }

      const tracked = trackedOutgoingDirectMessages.get(messageId);
      if (!tracked) {
        continue;
      }

      log("direct.dm.delivery_update", {
        messageId,
        remoteJid: messageUpdate.key.remoteJid ?? null,
        fromMe: messageUpdate.key.fromMe ?? null,
        participant: messageUpdate.key.participant ?? null,
        status: deliveryStatus,
        tracked,
      });
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

    if (callViolationPurgeTimer) {
      clearInterval(callViolationPurgeTimer);
      callViolationPurgeTimer = null;
    }

    if (globalBanEnforcementTimer) {
      clearInterval(globalBanEnforcementTimer);
      globalBanEnforcementTimer = null;
    }

    stopSpotlightScheduler();
    stopTicketMarketplaceRuleReminderScheduler();
    stopWebsiteTicketExchangeAnnouncementScheduler();
    stopAnnouncementScheduler();
    stopCleanupScheduler();

    const socketToClose = activeSocket;
    activeSocket = null;
    messageQueue.splice(0, messageQueue.length);
    if (socketToClose) {
      cleanupSocket(socketToClose);
    }
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
  typeof process.argv[1] === "string" &&
  (process.argv[1].endsWith("/src/index.ts") || process.argv[1].endsWith("/dist/index.js"));

if (isDirectExecution) {
  void startBot().catch((startupError) => {
    error("Failed to start bot", startupError);
    process.exitCode = 1;
  });
}
