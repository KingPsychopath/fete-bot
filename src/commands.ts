import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";

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
import {
  formatJidForDisplay,
  isAuthorised,
  isProtectedGroupMember,
  parseDuration,
  parseToJid,
} from "./utils.js";
import { normalizeJid } from "./lidMap.js";

const HELP_MESSAGE = `*Fete Bot — Admin Help*

*Targeting*
  • Reply to a group message — fastest, no extra args needed
  • DM by number — include {groupJid} if you have more than one group
  • !status shows group JIDs and your full config

*Action commands*
  Syntax: reply args | DM args

  !mute         {duration?}     | {number} {duration?} {groupJid?}
  !unmute       —               | {number} {groupJid?}
  !ban          {reason?}       | {number} {reason?} {groupJid?}
  !unban        DM only         | {number} {groupJid?}
  !remove       DM only         | {number} {groupJid?}
  !strike       {reason?}       | {number} {reason?} {groupJid?}
  !strikes      —               | {number}
  !pardon       —               | {number} {groupJid?}
  !undo         —               | —

*Info commands*
  !status
  !reviews
  !bans         {groupJid?}
  !mutes        {groupJid?}
  !audit        {limit?}
  !test         {url}
  !help

*Examples*
  Reply: !mute 2h
  Reply: !ban repeated promo links
  DM:    !mute 07911123456 2h
  DM:    !strike +447911123456 ignored warning
  DM:    !remove +12125550123
  DM:    !bans
  DM:    !audit 20

*Number format*
  UK:            07911123456  or  +447911123456
  International: always use + and country code
  Tip: unsure? Reply to their message instead.`;

const OWNER_HELP_BLOCK = `

*Owner only*
  !addmod {number} {note?}
  !removemod {number}
  !mods`;

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
  groupJids: string[];
  scopeLabel: string;
  expiresAt: number;
  undo: () => Promise<void>;
};

const undoableActions = new Map<string, UndoableAction>();
const destructiveCommandTimestamps = new Map<string, number[]>();

const normaliseCommand = (text: string): string => text.trim().toLowerCase();
const isOwner = (jid: string, config: Config): boolean => config.ownerJids.includes(jid);
const getActorIdentity = (
  candidateJids: readonly string[],
  config: Config,
): { actorJid: string; actorRole: "owner" | "moderator" } | null => {
  for (const candidateJid of candidateJids) {
    if (isOwner(candidateJid, config)) {
      return { actorJid: candidateJid, actorRole: "owner" };
    }
  }

  for (const candidateJid of candidateJids) {
    if (isAuthorised(candidateJid, config)) {
      return { actorJid: candidateJid, actorRole: "moderator" };
    }
  }

  return null;
};

const formatGroupName = (groupJid: string, groups: Map<string, string>): string =>
  groups.get(groupJid) ?? groupJid;

const formatPersonDisplay = (jid: string, pushName?: string | null): string => {
  const normalizedJid = normalizeJid(jid);
  const formatted = formatJidForDisplay(normalizedJid);

  if (pushName?.trim()) {
    return formatted === "internal user (lid)" ? pushName.trim() : `${pushName.trim()} (${formatted})`;
  }

  return formatted;
};

const formatCommandTarget = (jid: string): string => {
  const normalizedJid = normalizeJid(jid);
  return normalizedJid.endsWith("@s.whatsapp.net") ? formatJidForDisplay(normalizedJid) : normalizedJid;
};

const formatGroupScope = (groupJids: readonly string[], groups: Map<string, string>): string => {
  if (groupJids.length === 1) {
    return formatGroupName(groupJids[0] ?? "", groups);
  }

  return "all managed groups";
};

const getManagedGroupJids = (
  config: Config,
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): string[] => {
  if (config.allowedGroupJids.length > 0) {
    return [...config.allowedGroupJids];
  }

  return Array.from(groups.keys());
};

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

const resolveGroupTargets = (
  requestedGroupJid: string | null,
  config: Config,
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): { groupJids: string[]; explicit: boolean; invalid: boolean } => {
  const managedGroupJids = getManagedGroupJids(config, groups);

  if (requestedGroupJid) {
    if (!managedGroupJids.includes(requestedGroupJid)) {
      return { groupJids: [], explicit: true, invalid: true };
    }

    return { groupJids: [requestedGroupJid], explicit: true, invalid: false };
  }

  return {
    groupJids: managedGroupJids,
    explicit: false,
    invalid: false,
  };
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

  const remainingTokens = tokens.slice(consumedTokens + 1);
  const groupTokenIndex = remainingTokens.findIndex((token) => token.endsWith("@g.us"));
  const groupJid = groupTokenIndex >= 0 ? remainingTokens[groupTokenIndex] ?? null : null;
  const restTokens =
    groupTokenIndex >= 0
      ? remainingTokens.filter((_, index) => index !== groupTokenIndex)
      : remainingTokens;
  const rest = restTokens.join(" ");

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
  if (config.allowedGroupJids.length === 0) {
    return true;
  }

  if (!config.allowedGroupJids.includes(groupJid)) {
    await sock.sendMessage(senderJid, {
      text: `❌ ${groupJid} is not one of this bot's managed groups.`,
    });
    return false;
  }

  return true;
};

const ensureTargetNotAuthorised = async (
  sock: WASocket,
  senderJid: string,
  targetJid: string,
  groupJid: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  action: "ban" | "mute" | "strike",
): Promise<boolean> => {
  if (!isProtectedGroupMember([targetJid], groupJid, config, groupMetadataByJid)) {
    return true;
  }

  await sock.sendMessage(senderJid, {
    text: `❌ Can't ${action} an owner, moderator, or group admin.`,
  });
  return false;
};

const ensureTargetNotProtectedAcrossGroups = async (
  sock: WASocket,
  senderJid: string,
  targetJid: string,
  groupJids: readonly string[],
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  groups: Map<string, string>,
  action: "ban" | "mute" | "strike",
): Promise<boolean> => {
  const protectedGroupJids = groupJids.filter((groupJid) =>
    isProtectedGroupMember([targetJid], groupJid, config, groupMetadataByJid),
  );

  if (protectedGroupJids.length === 0) {
    return true;
  }

  const scope =
    protectedGroupJids.length === 1
      ? formatGroupName(protectedGroupJids[0] ?? "", groups)
      : formatGroupScope(protectedGroupJids, groups);

  await sock.sendMessage(senderJid, {
    text: `❌ Can't ${action} an owner, moderator, or group admin in ${scope}.`,
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
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  lidJid: string | null = null,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, senderJid, groupJid, config))) {
    return;
  }

  if (
    !(await ensureTargetNotAuthorised(
      sock,
      senderJid,
      targetJid,
      groupJid,
      config,
      groupMetadataByJid,
      "ban",
    ))
  ) {
    return;
  }

  addBan(targetJid, groupJid, senderJid, reason || undefined, lidJid);
  clearReviewQueueEntry(targetJid, groupJid);
  recordUndoAction(senderJid, {
    type: "ban",
    targetJid,
    groupJids: [groupJid],
    scopeLabel: groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeBan(targetJid, groupJid);
    },
  });

  try {
    await sock.groupParticipantsUpdate(groupJid, [lidJid ?? targetJid], "remove");
    await sock.sendMessage(senderJid, {
      text: `✅ Banned and removed ${formatPersonDisplay(targetJid)} from ${groupJid}
Reason: ${formatReason(reason)}
They will be auto-removed if they try to rejoin.`,
    });
  } catch {
    await sock.sendMessage(senderJid, {
      text: `✅ Ban saved for ${formatPersonDisplay(targetJid)} in ${groupJid}
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
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  lidJid: string | null = null,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, senderJid, groupJid, config))) {
    return;
  }

  if (
    !(await ensureTargetNotAuthorised(
      sock,
      senderJid,
      targetJid,
      groupJid,
      config,
      groupMetadataByJid,
      "mute",
    ))
  ) {
    return;
  }

  const expiresAt = parseDuration(durationInput);
  addMute(targetJid, groupJid, senderJid, expiresAt, undefined, lidJid);
  recordUndoAction(senderJid, {
    type: "mute",
    targetJid,
    groupJids: [groupJid],
    scopeLabel: formatGroupName(groupJid, groups),
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeMute(targetJid, groupJid);
    },
  });

  if (expiresAt) {
    await sock.sendMessage(senderJid, {
      text: `🔇 Muted ${formatPersonDisplay(targetJid)} in ${formatGroupName(groupJid, groups)}
Duration: ${formatDurationLabel(durationInput)}
Expires: ${formatDate(expiresAt.toISOString())}
Reason: none given

Their messages will be silently deleted until then.
Use !unmute ${formatCommandTarget(targetJid)} ${groupJid} to lift early.`,
    });
    return;
  }

  await sock.sendMessage(senderJid, {
    text: `🔇 Permanently muted ${formatPersonDisplay(targetJid)} in ${formatGroupName(groupJid, groups)}
Reason: none given

Their messages will be silently deleted indefinitely.
Use !unmute ${formatCommandTarget(targetJid)} ${groupJid} to lift.`,
  });
}

async function handleStrikeCommand(
  sock: WASocket,
  replyJid: string,
  targetJid: string,
  groupJid: string,
  reason: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<void> {
  if (config.allowedGroupJids.length > 0 && !config.allowedGroupJids.includes(groupJid)) {
    return;
  }

  if (
    !(await ensureTargetNotAuthorised(
      sock,
      replyJid,
      targetJid,
      groupJid,
      config,
      groupMetadataByJid,
      "strike",
    ))
  ) {
    return;
  }

  const count = addStrike(targetJid, groupJid, reason || "manual strike");
  recordUndoAction(replyJid, {
    type: "strike",
    targetJid,
    groupJids: [groupJid],
    scopeLabel: groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeLatestStrike(targetJid, groupJid);
    },
  });

  await sock.sendMessage(groupJid, {
    text: `⚠️ Added a strike for ${formatPersonDisplay(targetJid)}. Active strikes in this group: ${count}`,
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
    text: `✅ Undid ${action.type} for ${formatPersonDisplay(action.targetJid)} in ${action.scopeLabel}`,
  });
}

export async function handleGroupCommand(
  sock: WASocket,
  actorCandidateJids: readonly string[],
  groupJid: string,
  text: string,
  quotedParticipant: string | null,
  config: Config,
  groups: Map<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<boolean> {
  const actorIdentity = getActorIdentity(actorCandidateJids, config);
  if (!actorIdentity) {
    return false;
  }

  const { actorJid: senderJid, actorRole } = actorIdentity;

  const command = normaliseCommand(text).split(/\s+/)[0] ?? "";
  if (!command.startsWith("!")) {
    return false;
  }

  if (command === "!undo") {
    await handleUndoCommand(sock, groupJid, senderJid);
    logAudit(senderJid, actorRole, command, null, groupJid, text, "success");
    return true;
  }

  if (command === "!help") {
    await sock.sendMessage(senderJid, {
      text: actorRole === "owner" ? `${HELP_MESSAGE}${OWNER_HELP_BLOCK}` : HELP_MESSAGE,
    });
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
      groupMetadataByJid,
      quotedParticipant.endsWith("@lid") ? quotedParticipant : null,
    );
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!unmute") {
    removeMute(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `🔊 Unmuted ${formatPersonDisplay(quotedParticipant)} in ${formatGroupName(groupJid, groups)}
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
      groupMetadataByJid,
      quotedParticipant.endsWith("@lid") ? quotedParticipant : null,
    );
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strike") {
    await handleStrikeCommand(
      sock,
      senderJid,
      quotedParticipant,
      groupJid,
      rest,
      config,
      groupMetadataByJid,
    );
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!pardon") {
    resetStrikes(quotedParticipant, groupJid);
    clearReviewQueueEntry(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `✅ Strikes cleared for ${formatPersonDisplay(quotedParticipant)}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!resetstrikes") {
    resetStrikes(quotedParticipant, groupJid);
    clearReviewQueueEntry(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `✅ Strikes reset for ${formatPersonDisplay(quotedParticipant)}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strikes") {
    const count = getActiveStrikes(quotedParticipant, groupJid);
    await sock.sendMessage(groupJid, {
      text: `Strikes for ${formatPersonDisplay(quotedParticipant)} in ${formatGroupName(groupJid, groups)}: ${count}`,
    });
    logAudit(senderJid, actorRole, command, quotedParticipant, groupJid, text, "success");
    return true;
  }

  return false;
}

export async function handleAuthorisedCommand(
  sock: WASocket,
  actorCandidateJids: readonly string[],
  text: string,
  config: Config,
  groups: Map<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<void> {
  const actorIdentity = getActorIdentity(actorCandidateJids, config);
  if (!actorIdentity) {
    return;
  }

  const { actorJid: senderJid, actorRole } = actorIdentity;
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
    const managedGroupJids = getManagedGroupJids(config, groups);
    const configuredGroups = managedGroupJids.map((jid) => {
      const subject = groups.get(jid) ?? "Unknown Group";
      return `• ${subject} (${jid})`;
    });
    const groupSource = config.allowedGroupJids.length > 0 ? "config allowlist" : "joined groups";

    const statusMessage = `Fete Bot Status 🤖

Version: ${VERSION}
Started: ${STARTED_AT}
Mode: ${config.dryRun ? "DRY RUN (not deleting)" : "LIVE (deleting messages)"}

Active in ${configuredGroups.length} group(s):
${configuredGroups.length > 0 ? configuredGroups.join("\n") : "• None configured"}

Watching ${managedGroupJids.length} group JIDs from ${groupSource}.
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
        `${index + 1}. ${formatPersonDisplay(entry.userJid, entry.pushName)}
   User: ${formatPersonDisplay(entry.userJid, entry.pushName)}
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
   Actor: ${formatPersonDisplay(entry.actorJid)} (${entry.actorRole})
   Target: ${entry.targetJid ? formatPersonDisplay(entry.targetJid) : "n/a"}
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
      text: `✅ Added ${formatPersonDisplay(targetJid)} as moderator
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
    await sock.sendMessage(senderJid, { text: `✅ Removed ${formatPersonDisplay(targetJid)} as moderator` });
    logAudit(senderJid, actorRole, "!removemod", targetJid, null, text, "success");
    return;
  }

  if (command === "!mods") {
    const moderators = listModerators();
    const ownerLines =
      config.ownerJids.length > 0
        ? config.ownerJids.map((jid) => `• ${formatPersonDisplay(jid)}`)
        : ["• None configured"];
    const moderatorLines =
      moderators.length > 0
        ? moderators.map(
            (moderator) =>
              `• ${formatPersonDisplay(moderator.jid)} (added by ${formatPersonDisplay(
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
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);

    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !remove {number} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.some((groupJid) => isProtectedGroupMember([targetJid], groupJid, config, groupMetadataByJid))) {
      await sock.sendMessage(senderJid, {
        text: "❌ Can't remove an owner, moderator, or group admin.",
      });
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    try {
      const removedFromGroupJids: string[] = [];
      for (const groupJid of groupJids) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [targetJid], "remove");
          removedFromGroupJids.push(groupJid);
        } catch {
          // Keep going so one missing-membership case doesn't block the rest.
        }
        resetStrikes(targetJid, groupJid);
        clearReviewQueueEntry(targetJid, groupJid);
      }
      await sock.sendMessage(senderJid, {
        text: `✅ Removed ${formatPersonDisplay(targetJid)} from ${formatGroupScope(groupJids, groups)}`,
      });
      for (const groupJid of removedFromGroupJids) {
        await sock.sendMessage(groupJid, {
          text: "A member has been removed for repeated violations.",
        });
      }
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    } catch {
      await sock.sendMessage(senderJid, {
        text: "❌ Failed to remove user — make sure I'm an admin in that group",
      });
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
    }
    return;
  }

  if (parsed.command === "!pardon") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);

    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !pardon {number} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      resetStrikes(targetJid, groupJid);
      clearReviewQueueEntry(targetJid, groupJid);
    }

    await sock.sendMessage(
      senderJid,
      { text: `✅ Strikes cleared for ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}` },
    );
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!resetstrikes") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);

    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !resetstrikes {number} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      resetStrikes(targetJid, groupJid);
      clearReviewQueueEntry(targetJid, groupJid);
    }

    await sock.sendMessage(
      senderJid,
      { text: `✅ Strikes reset for ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}` },
    );
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strikes") {
    const targetJid = parsed.targetJid;

    if (!targetJid) {
      await sock.sendMessage(senderJid, { text: "Usage: !strikes {number}" });
      logAudit(senderJid, actorRole, parsed.command, null, null, text, "error");
      return;
    }

    const strikeMap = new Map(
      getActiveStrikesAcrossGroups(targetJid).map((row) => [row.group_jid, row.count]),
    );
    const groupJids = Array.from(new Set([...getManagedGroupJids(config, groups), ...strikeMap.keys()]));
    const lines =
      groupJids.length > 0
        ? groupJids.map(
            (groupJid) =>
              `• ${formatGroupName(groupJid, groups)}: ${strikeMap.get(groupJid) ?? 0} active strikes`,
          )
        : ["• No known groups"];

    await sock.sendMessage(senderJid, {
      text: `Strikes for ${formatPersonDisplay(targetJid)}:\n${lines.join("\n")}`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, null, text, "success");
    return;
  }

  if (parsed.command === "!ban") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !ban {number} {reason?} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (
      groupJids.length > 1 &&
      !(await ensureTargetNotProtectedAcrossGroups(
        sock,
        senderJid,
        targetJid,
        groupJids,
        config,
        groupMetadataByJid,
        groups,
        "ban",
      ))
    ) {
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.length === 1) {
      await handleBanCommand(
        sock,
        senderJid,
        targetJid,
        groupJids[0] ?? "",
        parsed.rest,
        config,
        groupMetadataByJid,
      );
      clearReviewQueueEntry(targetJid, groupJids[0] ?? "");
    } else {
      for (const groupJid of groupJids) {
        addBan(targetJid, groupJid, senderJid, parsed.rest || undefined);
        clearReviewQueueEntry(targetJid, groupJid);
      }
      recordUndoAction(senderJid, {
        type: "ban",
        targetJid,
        groupJids,
        scopeLabel: formatGroupScope(groupJids, groups),
        expiresAt: Date.now() + 5 * 60 * 1000,
        undo: async () => {
          for (const groupJid of groupJids) {
            removeBan(targetJid, groupJid);
          }
        },
      });
      for (const groupJid of groupJids) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [targetJid], "remove");
        } catch {
          // Ban remains active even if they are not currently in one of the groups.
        }
      }
      await sock.sendMessage(senderJid, {
        text: `✅ Banned ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}
Reason: ${formatReason(parsed.rest)}
They will be auto-removed if they try to rejoin.`,
      });
    }
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unban") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !unban {number} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }
    for (const groupJid of groupJids) {
      removeBan(targetJid, groupJid);
    }
    await sock.sendMessage(senderJid, {
      text: `✅ Ban lifted for ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}
They can now rejoin the group.`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!bans") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !bans {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "error");
      return;
    }
    const sections = groupJids
      .map((groupJid) => ({ groupJid, bans: getBans(groupJid) }))
      .filter((section) => section.bans.length > 0);
    if (sections.length === 0) {
      await sock.sendMessage(senderJid, { text: `No active bans in ${formatGroupScope(groupJids, groups)}` });
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "success");
      return;
    }
    const sectionText = sections
      .map(({ groupJid, bans }) => {
        const lines = bans.map(
          (ban, index) => `${index + 1}. ${formatPersonDisplay(ban.userJid)}
   Banned by: ${formatPersonDisplay(ban.bannedBy)}
   Reason: ${formatReason(ban.reason)}
   Date: ${ban.timestamp}`,
        );

        return `${formatGroupName(groupJid, groups)}:\n${lines.join("\n\n")}`;
      })
      .join("\n\n");
    await sock.sendMessage(senderJid, {
      text: `Active bans in ${formatGroupScope(groupJids, groups)}:\n\n${sectionText}`,
    });
    logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mute") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !mute {number} {duration?} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (
      groupJids.length > 1 &&
      !(await ensureTargetNotProtectedAcrossGroups(
        sock,
        senderJid,
        targetJid,
        groupJids,
        config,
        groupMetadataByJid,
        groups,
        "mute",
      ))
    ) {
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    const durationToken = parsed.rest.split(/\s+/)[0];
    if (groupJids.length === 1) {
      await handleMuteCommand(
        sock,
        senderJid,
        targetJid,
        groupJids[0] ?? "",
        durationToken,
        config,
        groups,
        groupMetadataByJid,
      );
    } else {
      const expiresAt = parseDuration(durationToken);
      for (const groupJid of groupJids) {
        addMute(targetJid, groupJid, senderJid, expiresAt, undefined);
      }
      recordUndoAction(senderJid, {
        type: "mute",
        targetJid,
        groupJids,
        scopeLabel: formatGroupScope(groupJids, groups),
        expiresAt: Date.now() + 5 * 60 * 1000,
        undo: async () => {
          for (const groupJid of groupJids) {
            removeMute(targetJid, groupJid);
          }
        },
      });
      await sock.sendMessage(senderJid, {
        text: `🔇 Muted ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}
Duration: ${expiresAt ? formatDurationLabel(durationToken) : "permanent"}
${expiresAt ? `Expires: ${formatDate(expiresAt.toISOString())}\n` : ""}Reason: none given`,
      });
    }
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unmute") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !unmute {number} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }
    for (const groupJid of groupJids) {
      removeMute(targetJid, groupJid);
    }
    await sock.sendMessage(senderJid, {
      text: `🔊 Unmuted ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}
They can now send messages again.`,
    });
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mutes") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !mutes {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "error");
      return;
    }
    const sections = groupJids
      .map((groupJid) => ({ groupJid, mutes: getActiveMutes(groupJid) }))
      .filter((section) => section.mutes.length > 0);
    if (sections.length === 0) {
      await sock.sendMessage(senderJid, {
        text: `No active mutes in ${formatGroupScope(groupJids, groups)}`,
      });
      logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "success");
      return;
    }
    const sectionText = sections
      .map(({ groupJid, mutes }) => {
        const lines = mutes.map(
          (mute, index) => `${index + 1}. ${formatPersonDisplay(mute.userJid)}
   Muted by: ${formatPersonDisplay(mute.mutedBy)}
   Reason: ${formatReason(mute.reason)}
   Expires: ${formatDate(mute.expiresAt)}`,
        );

        return `${formatGroupName(groupJid, groups)}:\n${lines.join("\n\n")}`;
      })
      .join("\n\n");
    await sock.sendMessage(senderJid, {
      text: `Active mutes in ${formatGroupScope(groupJids, groups)}:\n\n${sectionText}`,
    });
    logAudit(senderJid, actorRole, parsed.command, null, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strike") {
    const targetJid = parsed.targetJid;
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!targetJid || groupJids.length === 0) {
      await sock.sendMessage(
        senderJid,
        { text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !strike {number} {reason?} {groupJid?}" },
      );
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (
      groupJids.length > 1 &&
      !(await ensureTargetNotProtectedAcrossGroups(
        sock,
        senderJid,
        targetJid,
        groupJids,
        config,
        groupMetadataByJid,
        groups,
        "strike",
      ))
    ) {
      logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.length === 1) {
      await handleStrikeCommand(
        sock,
        senderJid,
        targetJid,
        groupJids[0] ?? "",
        parsed.rest,
        config,
        groupMetadataByJid,
      );
    } else {
      for (const groupJid of groupJids) {
        addStrike(targetJid, groupJid, parsed.rest || "manual strike");
      }
      recordUndoAction(senderJid, {
        type: "strike",
        targetJid,
        groupJids,
        scopeLabel: formatGroupScope(groupJids, groups),
        expiresAt: Date.now() + 5 * 60 * 1000,
        undo: async () => {
          for (const groupJid of groupJids) {
            removeLatestStrike(targetJid, groupJid);
          }
        },
      });
      await sock.sendMessage(senderJid, {
        text: `⚠️ Added a strike for ${formatPersonDisplay(targetJid)} in ${formatGroupScope(groupJids, groups)}.`,
      });
    }
    logAudit(senderJid, actorRole, parsed.command, targetJid, parsed.groupJid, text, "success");
  }
}
