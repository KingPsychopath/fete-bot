import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  useMultiFileAuthState,
  type GroupMetadata,
  type WASocket,
  type WAMessage,
  type WAMessageKey,
} from "@whiskeysockets/baileys";
import { createServer } from "node:http";
import pino from "pino";
import qrcodeTerminal from "qrcode-terminal";

import { config } from "./config.js";
import { handleAuthorisedCommand, handleGroupCommand } from "./commands.js";
import {
  addStrike,
  closeDb,
  initDb,
  isBanned,
  isMuted,
  logAction,
  purgeExpiredMutes,
  purgeExpiredStrikes,
} from "./db.js";
import { runStartupHealthCheck } from "./healthCheck.js";
import { containsDisallowedUrl } from "./linkChecker.js";
import { SpamDetector, type SpamReason } from "./spamDetector.js";
import { error, log, warn } from "./logger.js";
import { extractAllIdentifiers, isAuthorised, parseToJid } from "./utils.js";
import { STARTED_AT, VERSION } from "./version.js";

const spamDetector = new SpamDetector();
const discoveredGroups = new Map<string, string>();
const discoveredGroupMetadata = new Map<string, GroupMetadata>();
let strikePurgeTimer: ReturnType<typeof setInterval> | null = null;
let mutePurgeTimer: ReturnType<typeof setInterval> | null = null;
let activeSocket: WASocket | null = null;
let shuttingDown = false;
let reconnecting = false;
let socketInstanceCounter = 0;

const healthPort = Number(process.env.PORT ?? "3000");
const healthServer = createServer((req, res) => {
  if (req.url === "/health") {
    const healthy = activeSocket?.user !== undefined;
    res.writeHead(healthy ? 200 : 503);
    res.end(healthy ? "OK" : "DISCONNECTED");
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

type MessageContextInfo = {
  participant?: string | null;
  isForwarded?: boolean | null;
  forwardingScore?: number | null;
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

const extractMessageText = (msg: WAMessage): string => {
  const message = msg.message;
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

const getQuotedParticipant = (message: WAMessage["message"]): string | null => {
  return getMessageContextInfo(message)?.participant ?? null;
};

const getPushName = (msg: WAMessage): string | null => msg.pushName ?? null;

const getPhoneJid = (phoneNumber: string | null): string | null =>
  phoneNumber ? parseToJid(phoneNumber) : null;

const getBotIdentifiers = (sock: WASocket): Set<string> => {
  const identifiers = new Set<string>();
  const user = sock.user;

  if (user?.id) {
    identifiers.add(user.id);
  }

  if (typeof user?.lid === "string" && user.lid.length > 0) {
    identifiers.add(user.lid);
  }

  const phoneJid = getPhoneJid(user?.phoneNumber ?? null);
  if (phoneJid) {
    identifiers.add(phoneJid);
  }

  return identifiers;
};

const isForwardedMessage = (message: WAMessage["message"]): boolean => {
  const contextInfo = getMessageContextInfo(message);
  return Boolean(contextInfo?.isForwarded || (contextInfo?.forwardingScore ?? 0) >= 5);
};

const getMentionLabel = (
  senderJid: string,
  pushName: string | null,
  phoneJid?: string | null,
): string => {
  if (pushName && pushName.trim().length > 0) {
    return pushName.trim();
  }

  if (phoneJid?.endsWith("@s.whatsapp.net")) {
    return phoneJid.replace(/@s\.whatsapp\.net$/i, "");
  }

  if (senderJid.endsWith("@s.whatsapp.net")) {
    return senderJid.replace(/@s\.whatsapp\.net$/i, "");
  }

  return pushName ?? senderJid.split("@")[0] ?? senderJid;
};

const getMentionTargetJid = (senderJid: string, phoneJid?: string | null): string =>
  senderJid || phoneJid || "";

const getWarningText = (
  senderJid: string,
  pushName: string | null,
  reason?: string,
  phoneJid?: string | null,
): string => {
  const mentionLabel = getMentionLabel(senderJid, pushName, phoneJid);

  if (reason === "whatsapp invite link") {
    return `Hey @${mentionLabel} 👋 WhatsApp group invite links aren't allowed in here 🙏 Your message has been removed.`;
  }

  if (reason === "ticket platform") {
    return `Hey @${mentionLabel} 👋 We keep all event info in one place — search for it at fete.outofofficecollective.co.uk instead 🎉 Your message has been removed.`;
  }

  if (reason === "tiktok video (profile links only)") {
    return `Hey @${mentionLabel} 👋 TikTok profile links only please — share their profile page instead of a specific video 🎵 Your message has been removed.`;
  }

  if (reason === "youtube (music.youtube.com only)") {
    return `Hey @${mentionLabel} 👋 For YouTube, only YouTube Music links are allowed (music.youtube.com) 🎵 Your message has been removed.`;
  }

  if (reason === "url shortener") {
    return `Hey @${mentionLabel} 👋 Shortened links aren't allowed — please share the full URL instead 🙏 Your message has been removed.`;
  }

  return `Hey @${mentionLabel} 👋 Only social media profiles or music links are allowed in here please 🙏 Your message has been removed.`;
};

const getSpamWarningText = (
  senderJid: string,
  pushName: string | null,
  reason: SpamReason,
  phoneJid?: string | null,
): string => {
  const mentionLabel = getMentionLabel(senderJid, pushName, phoneJid);

  if (reason === "duplicate_message") {
    return `Hey @${mentionLabel} 👋 Please don't send the same message multiple times 🙏 Your message has been removed.`;
  }

  if (reason === "message_flood") {
    return `Hey @${mentionLabel} 👋 You're sending messages too quickly — slow down please 🙏 Your message has been removed.`;
  }

  return `Hey @${mentionLabel} 👋 Please don't share phone numbers in the group — for event info use fete.outofofficecollective.co.uk 🙏`;
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

Reply with:
!remove ${phoneJid ?? senderJid} ${groupJid} — to remove them
!pardon ${phoneJid ?? senderJid} ${groupJid} — to reset their strikes`;

  for (const ownerJid of config.ownerJids) {
    await sock.sendMessage(ownerJid, { text: dmText });
  }
};

const logConfig = (): void => {
  log("Loaded config", config);
  if (config.allowedGroupJids.length === 0) {
    warn("ALLOWED_GROUP_JIDS is empty, so the bot will not act in any groups.");
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
      discoveredGroupMetadata.set(jid, metadata);
      log("Discovered group", { jid, subject: metadata.subject });
    }
  } catch (groupError) {
    warn("Unable to fetch participating groups", groupError);
  }
};

const buildErrorLogMessage = (messageText: string, moderationError: unknown): string => {
  const errorMessage =
    moderationError instanceof Error ? moderationError.message : String(moderationError);

  return messageText.length > 0
    ? `${messageText}\n[ERROR] ${errorMessage}`
    : `[ERROR] ${errorMessage}`;
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

    if (remoteJid.endsWith("@s.whatsapp.net")) {
      const senderJid = msg.key.participant ?? remoteJid;
      if (text) {
        await handleAuthorisedCommand(sock, senderJid, text, config, discoveredGroups);
      }
      return;
    }

    const groupJid = remoteJid;
    if (!groupJid.endsWith("@g.us")) {
      return;
    }

    log(`Seen message from group JID: ${groupJid} — ${getPushName(msg) ?? "Unknown"}`);

    if (!config.allowedGroupJids.includes(groupJid)) {
      return;
    }

    const { senderJid, phoneNumber, lidJid } = extractAllIdentifiers(msg);
    const phoneJid = getPhoneJid(phoneNumber);
    const canonicalSenderJid = phoneJid ?? senderJid;
    if (!senderJid) {
      return;
    }

    if (getBotIdentifiers(sock).has(senderJid) || (phoneJid && getBotIdentifiers(sock).has(phoneJid))) {
      return;
    }

    if (text) {
      const handledGroupCommand = await handleGroupCommand(
        sock,
        canonicalSenderJid,
        groupJid,
        text,
        getQuotedParticipant(msg.message),
        config,
        discoveredGroups,
      );

      if (handledGroupCommand) {
        return;
      }
    }

    if (isAuthorised(senderJid, config) || (phoneJid && isAuthorised(phoneJid, config))) {
      return;
    }

    if (isForwardedMessage(msg.message)) {
      logAction({
        timestamp: new Date().toISOString(),
        group_jid: groupJid,
        user_jid: canonicalSenderJid,
        push_name: getPushName(msg),
        message_text: text || null,
        url_found: null,
        action: "WARN",
        reason: "forwarded message",
      });
      log("Forwarded message observed", {
        groupJid,
        senderJid: canonicalSenderJid,
        pushName: getPushName(msg),
      });
    }

    if (!text) {
      return;
    }

    try {
      if (isMuted(senderJid, groupJid) || (phoneJid ? isMuted(phoneJid, groupJid) : false)) {
        if (!config.dryRun) {
          await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        }

        warn("Deleted message from muted user", { senderJid: canonicalSenderJid, lidJid, groupJid });
        logAction({
          timestamp: new Date().toISOString(),
          group_jid: groupJid,
          user_jid: canonicalSenderJid,
          push_name: msg.pushName ?? "",
          message_text: text,
          url_found: null,
          action: config.dryRun ? "DRY_RUN" : "DELETED",
          reason: "muted user",
        });
        return;
      }
    } catch (muteError) {
      error("Failed mute check", { senderJid, groupJid, error: muteError });
    }

    log("Allowed group message", {
      groupJid,
      senderJid: canonicalSenderJid,
      lidJid,
      pushName: getPushName(msg),
      text,
    });

    const moderationResult = containsDisallowedUrl(text);
    const baseLogEntry = {
      timestamp: new Date().toISOString(),
      group_jid: groupJid,
      user_jid: canonicalSenderJid,
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
          senderJid: canonicalSenderJid,
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
          senderJid: canonicalSenderJid,
          url: moderationResult.url,
          reason: moderationResult.reason,
        });
        return;
      }

      try {
        await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        const strikeCount = addStrike(
          canonicalSenderJid,
          groupJid,
          moderationResult.reason ?? "unknown",
        );
        await sock.sendMessage(groupJid, {
          text: appendStrikeWarning(warningText, strikeCount),
          mentions: [mentionTargetJid],
        });

        if (strikeCount >= 3) {
          await sock.sendMessage(groupJid, {
            text: `@${getMentionLabel(senderJid, pushName, phoneJid)} has been flagged for removal after repeated violations. An owner or moderator will review shortly.`,
            mentions: [mentionTargetJid],
          });
          await notifyOwnersOfStrikeThree(
            sock,
            canonicalSenderJid,
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
          senderJid: canonicalSenderJid,
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
          senderJid: canonicalSenderJid,
          url: moderationResult.url,
          error: moderationError,
        });
      }
      return;
    }

    const spamResult = spamDetector.check(canonicalSenderJid, text);
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
        senderJid: canonicalSenderJid,
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
        senderJid: canonicalSenderJid,
        reason: spamResult.reason,
        action: spamResult.action,
      });
      return;
    }

    try {
      if (spamResult.action === "delete") {
        await sock.sendMessage(groupJid, { delete: msg.key as WAMessageKey });
        const strikeCount = addStrike(canonicalSenderJid, groupJid, spamResult.reason);
        await sock.sendMessage(groupJid, {
          text: appendStrikeWarning(spamWarningText, strikeCount),
          mentions: [mentionTargetJid],
        });

        if (strikeCount >= 3) {
          await sock.sendMessage(groupJid, {
            text: `@${getMentionLabel(senderJid, getPushName(msg), phoneJid)} has been flagged for removal after repeated violations. An owner or moderator will review shortly.`,
            mentions: [mentionTargetJid],
          });
          await notifyOwnersOfStrikeThree(
            sock,
            canonicalSenderJid,
            groupJid,
            getPushName(msg),
            spamResult.reason,
            phoneJid,
          );
        }
      } else {
        await sock.sendMessage(groupJid, {
          text: spamWarningText,
          mentions: [mentionTargetJid],
        });
      }

      logAction({
        ...spamLogEntry,
        action: spamResult.action === "delete" ? "DELETED" : "WARN",
      });

      warn("Moderated spam detection", {
        groupJid,
        senderJid: canonicalSenderJid,
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
        senderJid: canonicalSenderJid,
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
  initDb();
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

  const { state, saveCreds } = await useMultiFileAuthState("./auth");
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
  activeSocket = sock;

  sock.ev.on("creds.update", saveCreds);

  sock.ev.on("connection.update", (update) => {
    if (socketInstanceId !== socketInstanceCounter) {
      return;
    }

    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      log("QR received. Scan it with the WhatsApp Business account you want to use.");
      qrcodeTerminal.generate(qr, { small: true });
    }

    if (connection === "open") {
      reconnecting = false;
      log("Bot connected");
      void (async () => {
        await listDiscoveredGroups(sock);
        await runStartupHealthCheck(sock, config, discoveredGroupMetadata);
      })();
      return;
    }

    if (connection === "close") {
      if (shuttingDown) {
        return;
      }

      const statusCode = isBoomLike(lastDisconnect?.error)
        ? lastDisconnect.error.output?.statusCode
        : undefined;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

      warn("Connection closed", { statusCode, shouldReconnect });

      if (shouldReconnect && !shuttingDown && !reconnecting) {
        reconnecting = true;
        setTimeout(() => {
          void startBot();
        }, 1000);
      } else {
        warn("WhatsApp logged the bot out. Remove ./auth and pair again.");
      }
    }
  });

  sock.ev.on("group-participants.update", async (update) => {
    if (update.action !== "add") {
      return;
    }

    if (!config.allowedGroupJids.includes(update.id)) {
      return;
    }

    for (const participant of update.participants) {
      const participantJid = participant.id;
      const participantPhoneJid = getPhoneJid(participant.phoneNumber ?? null);

      try {
        if (
          !isBanned(participantJid, update.id) &&
          !(participantPhoneJid ? isBanned(participantPhoneJid, update.id) : false)
        ) {
          continue;
        }

        try {
          await sock.groupParticipantsUpdate(update.id, [participantJid], "remove");
          warn("Auto-removed banned user on rejoin", {
            userJid: participantJid,
            groupJid: update.id,
          });

          for (const ownerJid of config.ownerJids) {
            await sock.sendMessage(ownerJid, {
              text: `🚫 Banned user attempted to rejoin and was auto-removed.

User: ${participantPhoneJid ?? participantJid}
Group: ${update.id}

Use !unban ${participantPhoneJid ?? participantJid} ${update.id} to lift the ban.`,
            });
          }
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

    await activeSocket?.end(undefined);
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
