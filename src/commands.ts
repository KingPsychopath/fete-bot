import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "./config.js";
import {
  addBan,
  addModerator,
  addMute,
  addStrike,
  clearReviewQueueEntry,
  getActiveMutes,
  getActiveStrikes,
  getActiveStrikesAcrossGroups,
  getAuditEntries,
  getBans,
  getForwardedMessagesSeenToday,
  isMuted,
  listReviewQueueEntries,
  listModerators,
  getStrikesIssuedToday,
  getTotalActiveBans,
  getTotalActiveMutes,
  getTotalActiveStrikes,
  logAuditEntry,
  removeBan,
  removeLatestStrike,
  removeModerator,
  removeMute,
  resetStrikes,
} from "./db.js";
import { containsDisallowedUrl, type DisallowedUrlReason } from "./linkChecker.js";
import { STARTED_AT, VERSION } from "./version.js";
import { formatJidForDisplay, isAuthorised, parseDuration, parseToJid } from "./utils.js";

const HELP_MESSAGE = `Fete Bot Commands 🤖

── Reply-based (easiest) ──
Reply to any message, then send:
  !mute {duration?}    e.g. !mute / !mute 2h / !mute perm
  !unmute
  !ban {reason?}
  !strike
  !pardon
  !resetstrikes
  !strikes
  !undo

── Moderator + Owner ──
Works with any number format:
  !mute 07911123456 120363XXX@g.us 2h
  !ban 07911123456 120363XXX@g.us reason here
  !unban 07911123456 120363XXX@g.us
  !remove 07911123456 120363XXX@g.us
  !strike 07911123456 120363XXX@g.us reason here
  !strikes 07911123456
  !pardon 07911123456
  !resetstrikes 07911123456

Number formats accepted:
  UK:            07911123456 or +447911123456
  International: always use + and country code
  e.g. +1 212 555 0123 (US), +33 6 12 34 56 78 (France)
  Tip: when in doubt, reply to their message instead

── Info commands (DM only) ──
  !status
  !reviews
  !bans {groupJid}
  !mutes {groupJid}
  !audit {limit?}
  !test {url}
  !help`;

const OWNER_HELP_BLOCK = `

── Owner only ──
!addmod {number} {note?}   — add a moderator
!removemod {number}        — remove a moderator
!mods                      — list all moderators and owners`;

const INVALID_NUMBER_MESSAGE = `❌ Couldn't parse that as a phone number.

Try:
  07911 123456
  +447911123456
  447911123456

Or reply directly to the user's message instead.`;

type ParsedCommandArgs = {
  command: string;
  targetJid: string | null;
  groupJid: string | null;
  rest: string;
  parseFailed: boolean;
};

type UndoableAction = {
  type: "ban" | "mute" | "strike";
  targetJid: string;
  groupJid: string;
  expiresAt: number;
  undo: () => Promise<void>;
};

const undoableActions = new Map<string, UndoableAction>();
const destructiveCommandTimestamps = new Map<string, number[]>();

const normaliseCommand = (text: string): string => text.trim().toLowerCase();
const isOwner = (jid: string, config: Config): boolean => config.ownerJids.includes(jid);

const formatGroupName = (groupJid: string, groups: Map<string, string>): string =>
  groups.get(groupJid) ?? groupJid;

const formatReason = (reason?: string | null): string => reason?.trim() || "none";

const formatDate = (iso: string | null): string => {
  if (!iso) {
    return "permanent";
  }

  return new Date(iso).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  });
};

const formatDurationLabel = (input?: string): string => {
  const normalised = input?.trim().toLowerCase();
  if (!normalised) {
    return "24 hours";
  }

  if (normalised === "permanent" || normalised === "perm") {
    return "permanent";
  }

  const match = normalised.match(/^(\d+)([mhd])$/);
  if (!match) {
    return "24 hours";
  }

  const value = Number(match[1]);
  const labels = {
    m: value === 1 ? "minute" : "minutes",
    h: value === 1 ? "hour" : "hours",
    d: value === 1 ? "day" : "days",
  } as const;

  return `${value} ${labels[match[2] as keyof typeof labels]}`;
};

const resolveGroupArgument = (groupJid: string | null, config: Config): string | null => {
  if (groupJid) {
    return groupJid;
  }

  if (config.allowedGroupJids.length === 1) {
    return config.allowedGroupJids[0] ?? null;
  }

  return null;
};

const parseCommandArgs = (text: string): ParsedCommandArgs => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const command = (tokens[0] ?? "").toLowerCase();

  if (tokens.length <= 1) {
    return {
      command,
      targetJid: null,
      groupJid: null,
      rest: "",
      parseFailed: false,
    };
  }

  let targetJid: string | null = null;
  let consumedTokens = 0;

  for (let index = 1; index < tokens.length; index += 1) {
    const candidate = tokens.slice(1, index + 1).join(" ");
    const parsed = parseToJid(candidate);
    if (parsed) {
      targetJid = parsed;
      consumedTokens = index;
    }
  }

  const rawGroupCandidate = tokens[consumedTokens + 1];
  const groupJid = rawGroupCandidate?.endsWith("@g.us") ? rawGroupCandidate : null;
  const restStartIndex = groupJid ? consumedTokens + 2 : consumedTokens + 1;
  const rest = tokens.slice(restStartIndex).join(" ");

  return {
    command,
    targetJid,
    groupJid,
    rest,
    parseFailed: tokens.length > 1 && !targetJid && !tokens[1]?.endsWith("@g.us"),
  };
};

const parseDirectTargetAndRest = (
  text: string,
): { targetJid: string | null; rest: string; parseFailed: boolean } => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return { targetJid: null, rest: "", parseFailed: false };
  }

  let targetJid: string | null = null;
  let consumedTokens = 0;

  for (let index = 1; index < tokens.length; index += 1) {
    const candidate = tokens.slice(1, index + 1).join(" ");
    const parsed = parseToJid(candidate);
    if (parsed) {
      targetJid = parsed;
      consumedTokens = index;
    }
  }

  return {
    targetJid,
    rest: tokens.slice(consumedTokens + 1).join(" "),
    parseFailed: tokens.length > 1 && !targetJid,
  };
};

const previewWarningText = (reason: DisallowedUrlReason): string => {
  if (reason === "ticket platform") {
    return `Hey @name - please use fete.outofofficecollective.co.uk to share event links 🙏`;
  }

  if (reason === "tiktok video (profile links only)") {
    return `Hey @name - TikTok profile links only please. Share their profile page instead of a specific video 🎵`;
  }

  if (reason === "youtube (music.youtube.com only)") {
    return `Hey @name - only YouTube Music links are allowed for YouTube (music.youtube.com) 🎵`;
  }

  if (reason === "url shortener") {
    return `Hey @name - shortened links aren't allowed. Please share the full URL instead 🙏`;
  }

  if (reason === "whatsapp invite link") {
    return `Hey @name - WhatsApp group invite links aren't allowed in here 🙏`;
  }

  return `Hey @name - only social media profile links or music links are allowed in this group. If you're sharing an event, please use fete.outofofficecollective.co.uk 🙏`;
};

const sendInvalidNumber = async (sock: WASocket, destinationJid: string): Promise<void> => {
  await sock.sendMessage(destinationJid, { text: INVALID_NUMBER_MESSAGE });
};

const ensureAllowedGroup = async (
  sock: WASocket,
  senderJid: string,
  groupJid: string,
  config: Config,
): Promise<boolean> => {
  if (!config.allowedGroupJids.includes(groupJid)) {
    await sock.sendMessage(senderJid, {
      text: `❌ ${groupJid} is not in ALLOWED_GROUP_JIDS.`,
    });
    return false;
  }

  return true;
};

const ensureTargetNotAuthorised = async (
  sock: WASocket,
  senderJid: string,
  targetJid: string,
  config: Config,
  action: "ban" | "mute" | "strike",
): Promise<boolean> => {
  if (!isAuthorised(targetJid, config)) {
    return true;
  }

  await sock.sendMessage(senderJid, {
    text: `❌ Can't ${action} an owner or moderator.`,
  });
  return false;
};

const recordUndoAction = (actorJid: string, action: UndoableAction): void => {
  undoableActions.set(actorJid, action);
};

const consumeUndoAction = (actorJid: string): UndoableAction | null => {
  const action = undoableActions.get(actorJid);
  if (!action) {
    return null;
  }

  if (Date.now() > action.expiresAt) {
    undoableActions.delete(actorJid);
    return null;
  }

  undoableActions.delete(actorJid);
  return action;
};

const checkDestructiveCommandRateLimit = (actorJid: string): boolean => {
  const now = Date.now();
  const timestamps = (destructiveCommandTimestamps.get(actorJid) ?? []).filter(
    (timestamp) => now - timestamp < 60 * 1000,
  );

  if (timestamps.length >= 10) {
    destructiveCommandTimestamps.set(actorJid, timestamps);
    return false;
  }

  timestamps.push(now);
  destructiveCommandTimestamps.set(actorJid, timestamps);
  return true;
};

const logAudit = (
  actorJid: string,
  actorRole: "owner" | "moderator",
  command: string,
  targetJid: string | null,
  groupJid: string | null,
  rawInput: string,
  result: "success" | "error" | "pending",
): void => {
  logAuditEntry({
    timestamp: new Date().toISOString(),
    actorJid,
    actorRole,
    command,
    targetJid,
    groupJid,
    rawInput,
    result,
  });
};

async function handleBanCommand(
  sock: WASocket,
  senderJid: string,
  targetJid: string,
  groupJid: string,
  reason: string,
  config: Config,
  lidJid: string | null = null,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, senderJid, groupJid, config))) {
    return;
  }

  if (!(await ensureTargetNotAuthorised(sock, senderJid, targetJid, config, "ban"))) {
    return;
  }

  addBan(targetJid, groupJid, senderJid, reason || undefined, lidJid);
  clearReviewQueueEntry(targetJid, groupJid);
  recordUndoAction(senderJid, {
    type: "ban",
    targetJid,
    groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeBan(targetJid, groupJid);
    },
  });

  try {
    await sock.groupParticipantsUpdate(groupJid, [lidJid ?? targetJid], "remove");
    await sock.sendMessage(senderJid, {
      text: `✅ Banned and removed ${targetJid} from ${groupJid}
Reason: ${formatReason(reason)}
They will be auto-removed if they try to rejoin.`,
    });
  } catch {
    await sock.sendMessage(senderJid, {
      text: `✅ Ban saved for ${targetJid} in ${groupJid}
(They weren't in the group — ban is active for if they rejoin)`,
    });
  }
}

async function handleMuteCommand(
  sock: WASocket,
  senderJid: string,
  targetJid: string,
  groupJid: string,
  durationInput: string | undefined,
  config: Config,
  groups: Map<string, string>,
  lidJid: string | null = null,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, senderJid, groupJid, config))) {
    return;
  }

  if (!(await ensureTargetNotAuthorised(sock, senderJid, targetJid, config, "mute"))) {
    return;
  }

  const expiresAt = parseDuration(durationInput);
  addMute(targetJid, groupJid, senderJid, expiresAt, undefined, lidJid);
  recordUndoAction(senderJid, {
    type: "mute",
    targetJid,
    groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeMute(targetJid, groupJid);
    },
  });

  if (expiresAt) {
    await sock.sendMessage(senderJid, {
      text: `🔇 Muted ${targetJid} in ${formatGroupName(groupJid, groups)}
Duration: ${formatDurationLabel(durationInput)}
Expires: ${formatDate(expiresAt.toISOString())}
Reason: none given

Their messages will be silently deleted until then.
Use !unmute ${targetJid} ${groupJid} to lift early.`,
    });
    return;
  }

  await sock.sendMessage(senderJid, {
    text: `🔇 Permanently muted ${targetJid} in ${formatGroupName(groupJid, groups)}
Reason: none given

Their messages will be silently deleted indefinitely.
Use !unmute ${targetJid} ${groupJid} to lift.`,
  });
}

async function handleStrikeCommand(
  sock: WASocket,
  replyJid: string,
  targetJid: string,
  groupJid: string,
  reason: string,
  config: Config,
): Promise<void> {
  if (!config.allowedGroupJids.includes(groupJid)) {
    return;
  }

  if (!(await ensureTargetNotAuthorised(sock, replyJid, targetJid, config, "strike"))) {
    return;
  }

  const count = addStrike(targetJid, groupJid, reason || "manual strike");
  recordUndoAction(replyJid, {
    type: "strike",
    targetJid,
    groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeLatestStrike(targetJid, groupJid);
    },
  });

  await sock.sendMessage(groupJid, {
    text: `⚠️ Added a strike for ${targetJid}. Active strikes in this group: ${count}`,
  });
}

async function handleUndoCommand(
  sock: WASocket,
  destinationJid: string,
  actorJid: string,
): Promise<void> {
  const action = consumeUndoAction(actorJid);
  if (!action) {
    await sock.sendMessage(destinationJid, {
      text: "❌ Nothing to undo, or the undo window has expired.",
    });
    return;
  }

  await action.undo();
  await sock.sendMessage(destinationJid, {
    text: `✅ Undid ${action.type} for ${action.targetJid} in ${action.groupJid}`,
  });
}

export async function handleGroupCommand(
  sock: WASocket,
  senderJid: string,
  groupJid: string,
  text: string,
  quotedParticipant: string | null,
  config: Config,
  groups: Map<string, string>,
): Promise<boolean> {
  if (!isAuthorised(senderJid, config)) {
    return false;
  }

  const actorRole = isOwner(senderJid, config) ? "owner" : "moderator";

  const command = normaliseCommand(text).split(/\s+/)[0] ?? "";
  if (!command.startsWith("!")) {
    return false;
  }

  if (command === "!undo") {
    await handleUndoCommand(sock, groupJid, senderJid);
    logAudit(senderJid, actorRole, command, null, groupJid, text, "success");
    return true;
  }

  if (!quotedParticipant) {
    return false;
  }

  const rest = text.trim().split(/\s+/).slice(1).join(" ").trim();

  if (["!ban", "!mute", "!strike"].includes(command) && !checkDestructiveCommandRateLimit(senderJid)) {
    await sock.sendMessage(groupJid, {
      text: "Slow down — you've run 10 commands in the last minute. Try again shortly.",
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "error");
    return true;
  }

  if (command === "!mute") {
    const durationToken = rest.split(/\s+/)[0];
    await handleMuteCommand(
      sock,
      senderJid,
      quotedParticipant,
      groupJid,
      durationToken || undefined,
      config,
      groups,
      quotedParticipant.endsWith("@lid") ? quotedParticipant : null,
    );
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!unmute") {
    removeMute(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `🔊 Unmuted ${quotedParticipant} in ${formatGroupName(groupJid, groups)}
They can now send messages again.`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!ban") {
    await handleBanCommand(
      sock,
      senderJid,
      quotedParticipant,
      groupJid,
      rest,
      config,
      quotedParticipant.endsWith("@lid") ? quotedParticipant : null,
    );
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strike") {
    await handleStrikeCommand(sock, senderJid, quotedParticipant, groupJid, rest, config);
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!pardon") {
    resetStrikes(quotedParticipant, groupJid);
    clearReviewQueueEntry(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `✅ Strikes cleared for ${quotedParticipant}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!resetstrikes") {
    resetStrikes(quotedParticipant, groupJid);
    clearReviewQueueEntry(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `✅ Strikes reset for ${quotedParticipant}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strikes") {
    const count = getActiveStrikes(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `Strikes for ${quotedParticipant} in ${formatGroupName(groupJid, groups)}: ${count}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  return false;
}

export async function handleAuthorisedCommand(
  sock: WASocket,
  senderJid: string,
  text: string,
  config: Config,
  groups: Map<string, string>,
): Promise<void> {
  if (!isAuthorised(senderJid, config)) {
    return;
  }

  const actorRole = isOwner(senderJid, config) ? "owner" : "moderator";
  const command = normaliseCommand(text);

  if (command === "!help") {
    await sock.sendMessage(senderJid, {
      text: actorRole === "owner" ? `${HELP_MESSAGE}${OWNER_HELP_BLOCK}` : HELP_MESSAGE,
    });
    logAudit(senderJid, actorRole, "!help", null, null, text, "success");
    return;
  }

  if (command === "!undo") {
    await handleUndoCommand(sock, senderJid, senderJid);
    logAudit(senderJid, actorRole, "!undo", null, null, text, "success");
    return;
  }

  if (command === "!status") {
    const dbModerators = listModerators();
    const configuredGroups = config.allowedGroupJids.map((jid) => {
      const subject = groups.get(jid) ?? "Unknown Group";
      return `• ${subject} (${jid})`;
    });

    const statusMessage = `Fete Bot Status 🤖

Version: ${VERSION}
Started: ${STARTED_AT}
Mode: ${config.dryRun ? "DRY RUN (not deleting)" : "LIVE (deleting messages)"}

Active in ${configuredGroups.length} group(s):
${configuredGroups.length > 0 ? configuredGroups.join("\n") : "• None configured"}

Watching ${config.allowedGroupJids.length} group JIDs from config.
Owners: ${config.ownerJids.length} configured.
Moderators: ${dbModerators.length} configured.
Strikes issued today: ${getStrikesIssuedToday()}
Total active strikes: ${getTotalActiveStrikes()}
Total active bans: ${getTotalActiveBans()}
Total active mutes: ${getTotalActiveMutes()}
Forwarded messages seen today: ${getForwardedMessagesSeenToday()}`;

    await sock.sendMessage(senderJid, { text: statusMessage });
    logAudit(senderJid, actorRole, "!status", null, null, text, "success");
    return;
  }

  if (command === "!reviews") {
    const entries = listReviewQueueEntries();
    if (entries.length === 0) {
      await sock.sendMessage(senderJid, { text: "No pending review items right now." });
      logAudit(senderJid, actorRole, "!reviews", null, null, text, "success");
      return;
    }

    const lines = entries.map(
      (entry, index) =>
        `${index + 1}. ${entry.pushName ?? entry.userJid}
   User: ${entry.userJid}
   Group: ${formatGroupName(entry.groupJid, groups)} (${entry.groupJid})
   Last offence: ${entry.reason}
   Last message: ${entry.messageText?.trim() || "(no message text recorded)"}
   Active strikes: ${getActiveStrikes(entry.userJid, entry.groupJid)}
   Currently muted: ${isMuted(entry.userJid, entry.groupJid) ? "yes" : "no"}
   Flagged: ${entry.flaggedAt}`,
    );

    await sock.sendMessage(senderJid, {
      text: `Pending review queue:\n\n${lines.join("\n\n")}`,
    });
    logAudit(senderJid, actorRole, "!reviews", null, null, text, "success");
    return;
  }

  if (command.startsWith("!audit")) {
    const limit = Number(text.trim().split(/\s+/)[1] ?? "20");
    const entries = getAuditEntries(Number.isFinite(limit) && limit > 0 ? limit : 20);
    const lines =
      entries.length > 0
        ? entries.map(
            (entry, index) =>
              `${index + 1}. ${entry.timestamp} ${entry.command} [${entry.result}]
   Actor: ${entry.actorJid} (${entry.actorRole})
   Target: ${entry.targetJid ?? "n/a"}
   Group: ${entry.groupJid ?? "n/a"}
   Input: ${entry.rawInput ?? ""}`,
          )
        : ["No audit entries found."];
    await sock.sendMessage(senderJid, { text: lines.join("\n\n") });
    logAudit(senderJid, actorRole, "!audit", null, null, text, "success");
    return;
  }

  if (command.startsWith("!test ")) {
    const candidate = text.trim().slice("!test".length).trim();
    const result = containsDisallowedUrl(candidate);
    const response = result.found && result.reason
      ? `❌ Would block (reason: ${result.reason})
Would send: "${previewWarningText(result.reason)}"`
      : "✅ Would allow";
    await sock.sendMessage(senderJid, { text: response });
    logAudit(senderJid, actorRole, "!test", null, null, text, "success");
    return;
  }

  if (command === "!test") {
    await sock.sendMessage(senderJid, { text: "Usage: !test {url}" });
    logAudit(senderJid, actorRole, "!test", null, null, text, "error");
    return;
  }

  if (command.startsWith("!addmod")) {
    if (!isOwner(senderJid, config)) {
      await sock.sendMessage(senderJid, { text: "❌ Only owners can add moderators." });
      logAudit(senderJid, actorRole, "!addmod", null, null, text, "error");
      return;
    }

    const parsed = parseDirectTargetAndRest(text);
    const targetJid = parsed.targetJid;
    if (!targetJid) {
      await sendInvalidNumber(sock, senderJid);
      logAudit(senderJid, actorRole, "!addmod", null, null, text, "error");
      return;
    }

    addModerator(targetJid, senderJid, parsed.rest || undefined);
    await sock.sendMessage(senderJid, {
      text: `✅ Added ${targetJid} as moderator
Note: ${parsed.rest.trim() || "none"}
They can now use all moderation commands.`,
    });
    logAudit(senderJid, actorRole, "!addmod", targetJid, null, text, "success");
    return;
  }

  if (command.startsWith("!removemod")) {
    if (!isOwner(senderJid, config)) {
      await sock.sendMessage(senderJid, { text: "❌ Only owners can remove moderators." });
      logAudit(senderJid, actorRole, "!removemod", null, null, text, "error");
      return;
    }

    const parsed = parseDirectTargetAndRest(text);
    const targetJid = parsed.targetJid;
    if (!targetJid) {
      await sendInvalidNumber(sock, senderJid);
      logAudit(senderJid, actorRole, "!removemod", null, null, text, "error");
      return;
    }

    if (config.ownerJids.includes(targetJid)) {
      await sock.sendMessage(senderJid, {
        text: "❌ Can't remove an owner via commands. Change OWNER_JIDS and redeploy instead.",
      });
      logAudit(senderJid, actorRole, "!removemod", targetJid, null, text, "error");
      return;
    }

    removeModerator(targetJid);
    await sock.sendMessage(senderJid, { text: `✅ Removed ${targetJid} as moderator` });
    logAudit(senderJid, actorRole, "!removemod", targetJid, null, text, "success");
    return;
  }

  if (command === "!mods") {
    const moderators = listModerators();
    const ownerLines =
      config.ownerJids.length > 0
        ? config.ownerJids.map((jid) => `• ${formatJidForDisplay(jid)}`)
        : ["• None configured"];
    const moderatorLines =
      moderators.length > 0
        ? moderators.map(
            (moderator) =>
              `• ${formatJidForDisplay(moderator.jid)} (added by ${formatJidForDisplay(
                moderator.addedBy,
              )}, note: "${moderator.note ?? "none"}")`,
          )
        : ["• None"];

    await sock.sendMessage(senderJid, {
      text: `Fete Bot Moderators 🤖

Owners (config):
${ownerLines.join("\n")}

Moderators (database):
${moderatorLines.join("\n")}

Total: ${config.ownerJids.length + moderators.length} authorised users`,
    });
    logAudit(senderJid, actorRole, "!mods", null, null, text, "success");
    return;
  }

  const parsed = parseCommandArgs(text);

  if (
    ["!ban", "!mute", "!unban", "!unmute", "!strikes", "!pardon", "!resetstrikes", "!strike", "!remove"].includes(
      parsed.command,
    ) &&
    parsed.parseFailed
  ) {
    await sendInvalidNumber(sock, senderJid);
    logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "error");
    return;
  }

  if (["!ban", "!mute", "!strike"].includes(parsed.command) && !checkDestructiveCommandRateLimit(senderJid)) {
    await sock.sendMessage(senderJid, {
      text: "Slow down — you've run 10 commands in the last minute. Try again shortly.",
    });
    logAudit(senderJid, actorRole, parsed.command, parsed.targetJid, parsed.groupJid, text, "error");
    return;
  }

  if (parsed.command === "!remove") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);

    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !remove {jid} {groupJid}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }

    if (!(await ensureAllowedGroup(sock, senderJid, groupJid, config))) {
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }

    try {
      await sock.groupParticipantsUpdate(groupJid, [targetJid], "remove");
      resetStrikes(targetJid, groupJid);
      clearReviewQueueEntry(targetJid, groupJid);
      await sock.sendMessage(senderJid, { text: `✅ ${targetJid} removed from ${groupJid}` });
      await sock.sendMessage(groupJid, {
        text: "A member has been removed for repeated violations.",
      });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    } catch {
      await sock.sendMessage(senderJid, {
        text: "❌ Failed to remove user — make sure I'm an admin in that group",
      });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
    }
    return;
  }

  if (parsed.command === "!pardon") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);

    if (!targetJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !pardon {jid} {groupJid?}" });
      logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "error");
      return;
    }

    if (groupJid) {
      resetStrikes(targetJid, groupJid);
      clearReviewQueueEntry(targetJid, groupJid);
    } else {
      for (const allowedGroupJid of config.allowedGroupJids) {
        resetStrikes(targetJid, allowedGroupJid);
        clearReviewQueueEntry(targetJid, allowedGroupJid);
      }
    }

    await sock.sendMessage(senderJid, { text: `✅ Strikes cleared for ${targetJid}` });
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!resetstrikes") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);

    if (!targetJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !resetstrikes {jid} {groupJid?}" });
      logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "error");
      return;
    }

    if (groupJid) {
      resetStrikes(targetJid, groupJid);
      clearReviewQueueEntry(targetJid, groupJid);
    } else {
      for (const allowedGroupJid of config.allowedGroupJids) {
        resetStrikes(targetJid, allowedGroupJid);
        clearReviewQueueEntry(targetJid, allowedGroupJid);
      }
    }

    await sock.sendMessage(senderJid, { text: `✅ Strikes reset for ${targetJid}` });
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strikes") {
    const targetJid = parsed.targetJid;

    if (!targetJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !strikes {jid}" });
      logAudit(senderJid, actorRole, parsed.command, null, null, text, "error");
      return;
    }

    const strikeMap = new Map(
      getActiveStrikesAcrossGroups(targetJid).map((row) => [row.group_jid, row.count]),
    );
    const groupJids = Array.from(new Set([...config.allowedGroupJids, ...strikeMap.keys()]));
    const lines =
      groupJids.length > 0
        ? groupJids.map(
            (groupJid) =>
              `• ${formatGroupName(groupJid, groups)}: ${strikeMap.get(groupJid) ?? 0} active strikes`,
          )
        : ["• No known groups"];

    await sock.sendMessage(senderJid, {
      text: `Strikes for ${targetJid}:\n${lines.join("\n")}`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, null, text, "success");
    return;
  }

  if (parsed.command === "!ban") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);
    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !ban {jid} {groupJid?} {reason?}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }
    await handleBanCommand(sock, senderJid, targetJid, groupJid, parsed.rest, config);
    clearReviewQueueEntry(targetJid, groupJid);
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unban") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);
    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !unban {jid} {groupJid}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }
    removeBan(targetJid, groupJid);
    await sock.sendMessage(senderJid, {
      text: `✅ Ban lifted for ${targetJid} in ${groupJid}
They can now rejoin the group.`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!bans") {
    const tokens = text.trim().split(/\s+/);
    const groupJid = tokens[1] ?? resolveGroupArgument(null, config);
    if (!groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !bans {groupJid}" });
      logAudit(senderJid, actorRole, parsed.command, null, null, text, "error");
      return;
    }
    const bans = getBans(groupJid);
    if (bans.length === 0) {
      await sock.sendMessage(senderJid, { text: `No active bans in ${groupJid}` });
      logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "success");
      return;
    }
    const lines = bans.map(
      (ban, index) => `${index + 1}. ${ban.userJid}
   Banned by: ${ban.bannedBy}
   Reason: ${formatReason(ban.reason)}
   Date: ${ban.timestamp}`,
    );
    await sock.sendMessage(senderJid, {
      text: `Active bans in ${formatGroupName(groupJid, groups)}:\n\n${lines.join("\n\n")}`,
    });
    logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mute") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);
    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !mute {jid} {groupJid?} {duration?}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }
    await handleMuteCommand(
      sock,
      senderJid,
      targetJid,
      groupJid,
      parsed.rest.split(/\s+/)[0],
      config,
      groups,
    );
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unmute") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);
    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !unmute {jid} {groupJid}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }
    removeMute(targetJid, groupJid);
    await sock.sendMessage(senderJid, {
      text: `🔊 Unmuted ${targetJid} in ${formatGroupName(groupJid, groups)}
They can now send messages again.`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mutes") {
    const tokens = text.trim().split(/\s+/);
    const groupJid = tokens[1] ?? resolveGroupArgument(null, config);
    if (!groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !mutes {groupJid}" });
      logAudit(senderJid, actorRole, parsed.command, null, null, text, "error");
      return;
    }
    const mutes = getActiveMutes(groupJid);
    if (mutes.length === 0) {
      await sock.sendMessage(senderJid, {
        text: `No active mutes in ${formatGroupName(groupJid, groups)}`,
      });
      logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "success");
      return;
    }
    const lines = mutes.map(
      (mute, index) => `${index + 1}. ${mute.userJid}
   Muted by: ${mute.mutedBy}
   Reason: ${formatReason(mute.reason)}
   Expires: ${formatDate(mute.expiresAt)}`,
    );
    await sock.sendMessage(senderJid, {
      text: `Active mutes in ${formatGroupName(groupJid, groups)}:\n\n${lines.join("\n\n")}`,
    });
    logAudit(senderJid, actorRole, parsed.command, null, groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strike") {
    const targetJid = parsed.targetJid;
    const groupJid = resolveGroupArgument(parsed.groupJid, config);
    if (!targetJid || !groupJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !strike {jid} {groupJid?} {reason?}" });
      logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "error");
      return;
    }
    await handleStrikeCommand(sock, senderJid, targetJid, groupJid, parsed.rest, config);
    logAudit(senderJid, actorRole, parsed.command, targetJid, groupJid, text, "success");
  }
}
