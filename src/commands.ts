import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";
import { randomUUID } from "node:crypto";

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
  getBanGroupJids,
  getBans,
  getForwardedMessagesSeenToday,
  getStrikesIssuedToday,
  getTotalActiveBans,
  getTotalActiveMutes,
  getTotalActiveStrikes,
  isMuted,
  listModerators,
  listReviewQueueEntries,
  logAuditEntry,
  removeBan,
  removeLatestStrike,
  removeModerator,
  removeMute,
  resetStrikes,
  type ActorReference,
  type AuditResult,
  type ReviewQueueEntry,
} from "./db.js";
import {
  describeUser,
  findParticipantJidForUser,
  findUserByIdentifier,
  getShortUserId,
  parseIdentifier,
  parseIdentifierDetailed,
  resolveParticipantTarget,
  resolveTargetFromIdentifier,
  type ResolvedUser,
  type UserSummary,
} from "./identity.js";
import { containsDisallowedUrl, type DisallowedUrlReason } from "./linkChecker.js";
import { STARTED_AT, VERSION } from "./version.js";
import {
  formatJidForDisplay,
  isAuthorised,
  isProtectedGroupMember,
  parseDuration,
} from "./utils.js";

const HELP_MESSAGE = `*Fete Bot — Admin Help*

*Targeting*
  • Reply to a group message — fastest, no extra args needed
  • DM by number, WhatsApp JID, or LID — include {groupJid} if needed
  • !status shows group JIDs and your full config

*Action commands*
  Syntax: reply args | DM args

  !mute         {duration?}     | {identifier} {duration?} {groupJid?}
  !unmute       —               | {identifier} {groupJid?}
  !ban          {reason?}       | {identifier} {reason?} {groupJid?}
  !unban        DM only         | {identifier} {groupJid?}
  !remove/!kick —               | {identifier} {groupJid?}
  !strike       {reason?}       | {identifier} {reason?} {groupJid?}
  !strikes      —               | {identifier}
  !pardon       —               | {identifier} {groupJid?}
  !whois        —               | {identifier}
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
  Reply: !whois
  DM:    !mute 07911123456 2h
  DM:    !strike +447911123456 ignored warning
  DM:    !kick lid:abc123def456
  DM:    !whois 447911123456@s.whatsapp.net

*Number format*
  UK:            07911123456 only if DEFAULT_PHONE_REGION is set, or +447911123456
  International: always use + and country code
  Bare digits:   7768986864 is rejected as ambiguous
  Tip: unsure? Reply to their message instead.`;

const OWNER_HELP_BLOCK = `

*Owner only*
  !addmod {identifier} {note?}
  !removemod {identifier}
  !mods`;

const INVALID_IDENTIFIER_MESSAGE = `❌ Couldn't parse that as a user identifier.

Try:
  +447911123456
  00447911123456
  07911 123456
  447911123456@s.whatsapp.net
  lid:abc123def456
  abc123def456@lid

Bare numbers like 7768986864 are rejected because they're ambiguous.

Or reply directly to the user's message instead.`;

type ActorContext = {
  userId: string;
  participantJid: string | null;
  knownAliases: string[];
  actorRole: "owner" | "moderator";
};

type ParsedCommandArgs = {
  command: string;
  targetIdentifier: string | null;
  groupJid: string | null;
  rest: string;
  parseFailed: boolean;
};

type UndoableAction = {
  type: "ban" | "mute" | "strike";
  targetUserId: string;
  scopeLabel: string;
  expiresAt: number;
  undo: () => Promise<void>;
};

const undoableActions = new Map<string, UndoableAction>();
const destructiveCommandTimestamps = new Map<string, number[]>();

const normaliseCommand = (text: string): string => text.trim().toLowerCase();
const getCommandToken = (text: string): string => normaliseCommand(text).split(/\s+/)[0] ?? "";
const canonicalCommand = (command: string): string => command === "!kick" ? "!remove" : command;
const isDestructiveCommand = (command: string): boolean =>
  ["!ban", "!mute", "!strike", "!remove"].includes(canonicalCommand(command));
const COMMANDS_WITH_TARGET = new Set([
  "!ban",
  "!mute",
  "!unban",
  "!unmute",
  "!strikes",
  "!pardon",
  "!resetstrikes",
  "!strike",
  "!remove",
  "!whois",
]);

const getReplyJidForActor = (actor: ResolvedUser): string | null =>
  actor.participantJid ??
  actor.knownAliases.find((alias) => alias.endsWith("@s.whatsapp.net") || alias.endsWith("@lid")) ??
  null;

const formatGroupName = (
  groupJid: string,
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): string => {
  const group = groups.get(groupJid);
  if (typeof group === "string") {
    return group;
  }

  return group?.subject ?? groupJid;
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

const formatGroupScope = (
  groupJids: readonly string[],
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): string => {
  if (groupJids.length === 1) {
    return formatGroupName(groupJids[0] ?? "", groups);
  }

  return "all managed groups";
};

const formatGroupList = (
  groupJids: readonly string[],
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): string => groupJids.map((groupJid) => formatGroupName(groupJid, groups)).join(", ");

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

const formatUserSummary = (summary: UserSummary, fallbackPushName?: string | null): string => {
  const phoneAlias = summary.aliases.find((alias) => alias.aliasType === "phone")?.alias ?? null;
  const lidAlias = summary.aliases.find((alias) => alias.aliasType === "lid")?.alias ?? null;
  const primaryAlias = phoneAlias ?? lidAlias ?? summary.userId;
  const primaryLabel = primaryAlias.includes("@") ? formatJidForDisplay(primaryAlias) : primaryAlias;
  const displayName = summary.displayName?.trim() || fallbackPushName?.trim() || null;

  if (displayName) {
    return `${displayName} (${primaryLabel}, ${summary.shortId})`;
  }

  return `${primaryLabel} (${summary.shortId})`;
};

const formatUserById = (userId: string, fallbackPushName?: string | null): string => {
  const summary = describeUser(userId);
  if (!summary) {
    return `${userId} (${getShortUserId(userId)})`;
  }

  return formatUserSummary(summary, fallbackPushName);
};

const formatActorReference = (actor: ActorReference): string => {
  if (actor.userId) {
    return formatUserById(actor.userId);
  }

  return actor.label;
};

const getActorReference = (actor: ActorContext, fallbackLabel?: string | null): ActorReference => ({
  userId: actor.userId,
  label: fallbackLabel?.trim() || actor.participantJid || actor.userId,
});

const getActorRole = (actor: ResolvedUser, config: Config): "owner" | "moderator" | null => {
  if (actor.knownAliases.some((alias) => config.ownerJids.includes(alias))) {
    return "owner";
  }

  return isAuthorised(actor.userId, actor.knownAliases, config) ? "moderator" : null;
};

const getActorContext = (actor: ResolvedUser, config: Config): ActorContext | null => {
  const actorRole = getActorRole(actor, config);
  if (!actorRole) {
    return null;
  }

  return {
    userId: actor.userId,
    participantJid: actor.participantJid,
    knownAliases: actor.knownAliases,
    actorRole,
  };
};

const parseTargetSpecifier = (
  text: string,
): { targetIdentifier: string | null; rest: string; parseFailed: boolean } => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length <= 1) {
    return { targetIdentifier: null, rest: "", parseFailed: false };
  }

  let targetIdentifier: string | null = null;
  let consumedTokens = 0;

  for (let index = 1; index < tokens.length; index += 1) {
    const candidate = tokens.slice(1, index + 1).join(" ");
    if (parseIdentifier(candidate)) {
      targetIdentifier = candidate;
      consumedTokens = index;
    }
  }

  return {
    targetIdentifier,
    rest: tokens.slice(consumedTokens + 1).join(" "),
    parseFailed: tokens.length > 1 && !targetIdentifier,
  };
};

const parseCommandArgs = (text: string): ParsedCommandArgs => {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const command = canonicalCommand((tokens[0] ?? "").toLowerCase());
  const parsed = parseTargetSpecifier(text);
  const remainingTokens = parsed.targetIdentifier
    ? tokens.slice((text.trim().split(/\s+/).findIndex((token) => token === parsed.targetIdentifier?.split(/\s+/)[0]) || 0) + 1)
    : tokens.slice(1);

  const restTokens = parsed.rest.trim().split(/\s+/).filter(Boolean);
  const groupTokenIndex = restTokens.findIndex((token) => token.endsWith("@g.us"));
  const groupJid = groupTokenIndex >= 0 ? restTokens[groupTokenIndex] ?? null : null;
  const rest =
    groupTokenIndex >= 0
      ? restTokens.filter((_, index) => index !== groupTokenIndex).join(" ")
      : parsed.rest;

  return {
    command,
    targetIdentifier: parsed.targetIdentifier,
    groupJid,
    rest: rest.trim(),
    parseFailed: parsed.parseFailed,
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

const sendInvalidIdentifier = async (sock: WASocket, destinationJid: string): Promise<void> => {
  await sock.sendMessage(destinationJid, { text: INVALID_IDENTIFIER_MESSAGE });
};

const sendIdentifierParseFailure = async (
  sock: WASocket,
  destinationJid: string,
  identifier?: string | null,
): Promise<void> => {
  if (!identifier) {
    await sendInvalidIdentifier(sock, destinationJid);
    return;
  }

  const parsed = parseIdentifierDetailed(identifier);
  if ("alias" in parsed) {
    await sendInvalidIdentifier(sock, destinationJid);
    return;
  }

  const lines = [`❌ Couldn't parse "${identifier}" as a user identifier.`];
  if (parsed.hint) {
    lines.push("", `Hint: ${parsed.hint}`);
  }
  lines.push(
    "",
    "Examples:",
    "  +447911123456",
    "  00447911123456",
    "  07911 123456",
    "  447911123456@s.whatsapp.net",
    "  lid:abc123def456",
  );

  await sock.sendMessage(destinationJid, { text: lines.join("\n") });
};

const resolveGroupTargets = (
  requestedGroupJid: string | null,
  config: Config,
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): { groupJids: string[]; invalid: boolean } => {
  const managedGroupJids = getManagedGroupJids(config, groups);
  if (!requestedGroupJid) {
    return { groupJids: managedGroupJids, invalid: false };
  }

  if (!managedGroupJids.includes(requestedGroupJid)) {
    return { groupJids: [], invalid: true };
  }

  return { groupJids: [requestedGroupJid], invalid: false };
};

const getBanListingTargets = (
  requestedGroupJid: string | null,
  config: Config,
  groups: ReadonlyMap<string, string> | ReadonlyMap<string, GroupMetadata>,
): { groupJids: string[]; invalid: boolean; scopeLabel: string } => {
  if (requestedGroupJid) {
    const resolved = resolveGroupTargets(requestedGroupJid, config, groups);
    return {
      ...resolved,
      scopeLabel: resolved.groupJids.length > 0 ? formatGroupScope(resolved.groupJids, groups) : "that group",
    };
  }

  return {
    groupJids: getBanGroupJids(),
    invalid: false,
    scopeLabel: "all groups",
  };
};

const ensureAllowedGroup = async (
  sock: WASocket,
  replyJid: string,
  groupJid: string,
  config: Config,
): Promise<boolean> => {
  if (config.allowedGroupJids.length === 0 || config.allowedGroupJids.includes(groupJid)) {
    return true;
  }

  await sock.sendMessage(replyJid, {
    text: `❌ ${groupJid} is not one of this bot's managed groups.`,
  });
  return false;
};

const ensureTargetNotProtected = async (
  sock: WASocket,
  destinationJid: string,
  target: ResolvedUser,
  groupJid: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  action: "ban" | "mute" | "strike" | "remove",
): Promise<boolean> => {
  if (!isProtectedGroupMember(target.userId, target.knownAliases, groupJid, config, groupMetadataByJid)) {
    return true;
  }

  await sock.sendMessage(destinationJid, {
    text: `❌ Can't ${action} an owner, moderator, or group admin.`,
  });
  return false;
};

const ensureTargetNotProtectedAcrossGroups = async (
  sock: WASocket,
  destinationJid: string,
  target: ResolvedUser,
  groupJids: readonly string[],
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  groups: Map<string, string>,
  action: "ban" | "mute" | "strike" | "remove",
): Promise<boolean> => {
  const protectedGroupJids = groupJids.filter((groupJid) =>
    isProtectedGroupMember(target.userId, target.knownAliases, groupJid, config, groupMetadataByJid),
  );

  if (protectedGroupJids.length === 0) {
    return true;
  }

  const scope =
    protectedGroupJids.length === 1
      ? formatGroupName(protectedGroupJids[0] ?? "", groups)
      : formatGroupScope(protectedGroupJids, groups);

  await sock.sendMessage(destinationJid, {
    text: `❌ Can't ${action} an owner, moderator, or group admin in ${scope}.`,
  });
  return false;
};

const recordUndoAction = (actorUserId: string, action: UndoableAction): void => {
  undoableActions.set(actorUserId, action);
};

const consumeUndoAction = (actorUserId: string): UndoableAction | null => {
  const action = undoableActions.get(actorUserId);
  if (!action) {
    return null;
  }

  if (Date.now() > action.expiresAt) {
    undoableActions.delete(actorUserId);
    return null;
  }

  undoableActions.delete(actorUserId);
  return action;
};

const checkDestructiveCommandRateLimit = (actorUserId: string): boolean => {
  const now = Date.now();
  const timestamps = (destructiveCommandTimestamps.get(actorUserId) ?? []).filter(
    (timestamp) => now - timestamp < 60 * 1000,
  );

  if (timestamps.length >= 10) {
    destructiveCommandTimestamps.set(actorUserId, timestamps);
    return false;
  }

  timestamps.push(now);
  destructiveCommandTimestamps.set(actorUserId, timestamps);
  return true;
};

const logAudit = (
  actor: ActorContext,
  command: string,
  targetUserId: string | null,
  targetJid: string | null,
  groupJid: string | null,
  rawInput: string,
  result: AuditResult,
): void => {
  logAuditEntry({
    timestamp: new Date().toISOString(),
    actorUserId: actor.userId,
    actorJid: actor.participantJid,
    actorRole: actor.actorRole,
    command,
    targetUserId,
    targetJid,
    groupJid,
    rawInput,
    result,
  });
};

const resolveIdentifierTarget = async (
  identifier: string,
  selfJids: ReadonlySet<string>,
): Promise<ResolvedUser | null> => resolveTargetFromIdentifier(identifier, selfJids);

const resolveQuotedTarget = async (
  quotedParticipant: string,
  groupJid: string,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<ResolvedUser | null> =>
  resolveParticipantTarget(
    quotedParticipant,
    groupMetadataByJid.get(groupJid),
    selfJids,
  );

const buildWhoisText = (summary: ReturnType<typeof describeUser>): string => {
  if (!summary) {
    return "No user found for that identifier.";
  }

  const aliasLines =
    summary.aliases.length > 0
      ? summary.aliases.map((alias) => {
          const label = alias.alias.includes("@") ? formatJidForDisplay(alias.alias) : alias.alias;
          return `• ${alias.aliasType}: ${label} (${alias.alias})`;
        })
      : ["• none"];
  const mergeLines =
    summary.mergeHistory.length > 0
      ? summary.mergeHistory.map(
          (entry) =>
            `• ${entry.reason} | ${new Date(entry.mergedAt).toLocaleString("en-GB", {
              dateStyle: "medium",
              timeStyle: "short",
            })} | survivor ${entry.survivorUserId} | merged ${entry.mergedUserId}`,
        )
      : ["• none"];

  return `User summary

Name: ${summary.displayName ?? "unknown"}
User ID: ${summary.userId}
Short ID: ${summary.shortId}
Created: ${new Date(summary.createdAt).toLocaleString("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
  })}
Merged into: ${summary.mergedInto ?? "active"}

Aliases:
${aliasLines.join("\n")}

Merge history:
${mergeLines.join("\n")}`;
};

async function handleBanCommand(
  sock: WASocket,
  actor: ActorContext,
  destinationJid: string,
  target: ResolvedUser,
  groupJid: string,
  reason: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, destinationJid, groupJid, config))) {
    return;
  }

  if (!(await ensureTargetNotProtected(sock, destinationJid, target, groupJid, config, groupMetadataByJid, "ban"))) {
    return;
  }

  addBan(target.userId, groupJid, getActorReference(actor), reason || undefined);
  clearReviewQueueEntry(target.userId, groupJid);
  recordUndoAction(actor.userId, {
    type: "ban",
    targetUserId: target.userId,
    scopeLabel: groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeBan(target.userId, groupJid);
    },
  });

  const liveParticipantJid = findParticipantJidForUser(target.userId, groupMetadataByJid.get(groupJid));
  if (liveParticipantJid) {
    try {
      await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
      await sock.sendMessage(destinationJid, {
        text: `✅ Banned and removed ${formatUserSummary(target)} from ${groupJid}
Reason: ${formatReason(reason)}
They will be auto-removed if they try to rejoin.`,
      });
      return;
    } catch {
      // Fall through to the saved-ban message.
    }
  }

  await sock.sendMessage(destinationJid, {
    text: `✅ Ban saved for ${formatUserSummary(target)} in ${groupJid}
(They weren't in the group — ban is active for if they rejoin)`,
  });
}

async function handleMuteCommand(
  sock: WASocket,
  actor: ActorContext,
  destinationJid: string,
  target: ResolvedUser,
  groupJid: string,
  durationInput: string | undefined,
  config: Config,
  groups: Map<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<void> {
  if (!(await ensureAllowedGroup(sock, destinationJid, groupJid, config))) {
    return;
  }

  if (!(await ensureTargetNotProtected(sock, destinationJid, target, groupJid, config, groupMetadataByJid, "mute"))) {
    return;
  }

  const expiresAt = parseDuration(durationInput);
  addMute(target.userId, groupJid, getActorReference(actor), expiresAt, undefined);
  recordUndoAction(actor.userId, {
    type: "mute",
    targetUserId: target.userId,
    scopeLabel: formatGroupName(groupJid, groups),
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeMute(target.userId, groupJid);
    },
  });

  const headline = expiresAt ? `🔇 Muted ${formatUserSummary(target)} in ${formatGroupName(groupJid, groups)}` : `🔇 Permanently muted ${formatUserSummary(target)} in ${formatGroupName(groupJid, groups)}`;
  const detailLines = expiresAt
    ? [
        `Duration: ${formatDurationLabel(durationInput)}`,
        `Expires: ${formatDate(expiresAt.toISOString())}`,
      ]
    : [];

  await sock.sendMessage(destinationJid, {
    text: `${headline}
${detailLines.join("\n")}${detailLines.length > 0 ? "\n" : ""}Reason: none given

Their messages will be silently deleted until lifted.`,
  });
}

async function handleStrikeCommand(
  sock: WASocket,
  actor: ActorContext,
  destinationJid: string,
  target: ResolvedUser,
  groupJid: string,
  reason: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): Promise<void> {
  if (config.allowedGroupJids.length > 0 && !config.allowedGroupJids.includes(groupJid)) {
    return;
  }

  if (!(await ensureTargetNotProtected(sock, destinationJid, target, groupJid, config, groupMetadataByJid, "strike"))) {
    return;
  }

  const count = addStrike(target.userId, groupJid, reason || "manual strike", randomUUID());
  recordUndoAction(actor.userId, {
    type: "strike",
    targetUserId: target.userId,
    scopeLabel: groupJid,
    expiresAt: Date.now() + 5 * 60 * 1000,
    undo: async () => {
      removeLatestStrike(target.userId, groupJid);
    },
  });

  await sock.sendMessage(destinationJid, {
    text: `⚠️ Added a strike for ${formatUserSummary(target)}. Active strikes in this group: ${count}`,
  });
}

async function handleUndoCommand(
  sock: WASocket,
  destinationJid: string,
  actor: ActorContext,
): Promise<void> {
  const action = consumeUndoAction(actor.userId);
  if (!action) {
    await sock.sendMessage(destinationJid, {
      text: "❌ Nothing to undo, or the undo window has expired.",
    });
    return;
  }

  await action.undo();
  await sock.sendMessage(destinationJid, {
    text: `✅ Undid ${action.type} for ${formatUserById(action.targetUserId)} in ${action.scopeLabel}`,
  });
}

const buildReviewText = (entry: ReviewQueueEntry, groups: Map<string, string>): string =>
  `${formatUserById(entry.userId, entry.pushName)}
   User: ${formatUserById(entry.userId, entry.pushName)}
   Group: ${formatGroupName(entry.groupJid, groups)} (${entry.groupJid})
   Last offence: ${entry.reason}
   Last message: ${entry.messageText?.trim() || "(no message text recorded)"}
   Active strikes: ${getActiveStrikes(entry.userId, entry.groupJid)}
   Currently muted: ${isMuted(entry.userId, entry.groupJid) ? "yes" : "no"}
   Flagged: ${entry.flaggedAt}`;

export async function handleGroupCommand(
  sock: WASocket,
  actor: ResolvedUser,
  groupJid: string,
  text: string,
  quotedParticipant: string | null,
  config: Config,
  groups: Map<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<boolean> {
  const actorContext = getActorContext(actor, config);
  if (!actorContext) {
    return false;
  }

  const command = canonicalCommand(getCommandToken(text));
  if (!command.startsWith("!")) {
    return false;
  }

  if (command === "!undo") {
    await handleUndoCommand(sock, groupJid, actorContext);
    logAudit(actorContext, command, null, null, groupJid, text, "success");
    return true;
  }

  if (command === "!help") {
    await sock.sendMessage(actorContext.participantJid ?? groupJid, {
      text: actorContext.actorRole === "owner" ? `${HELP_MESSAGE}${OWNER_HELP_BLOCK}` : HELP_MESSAGE,
    });
    logAudit(actorContext, command, null, null, groupJid, text, "success");
    return true;
  }

  if (!quotedParticipant) {
    return false;
  }

  const target = await resolveQuotedTarget(quotedParticipant, groupJid, groupMetadataByJid, selfJids);
  if (!target) {
    await sendInvalidIdentifier(sock, groupJid);
    logAudit(actorContext, command, null, quotedParticipant, groupJid, text, "error");
    return true;
  }

  const rest = text.trim().split(/\s+/).slice(1).join(" ").trim();

  if (isDestructiveCommand(command) && !checkDestructiveCommandRateLimit(actorContext.userId)) {
    await sock.sendMessage(groupJid, {
      text: "Slow down — you've run 10 commands in the last minute. Try again shortly.",
    });
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "error");
    return true;
  }

  if (command === "!mute") {
    const durationToken = rest.split(/\s+/)[0];
    await handleMuteCommand(
      sock,
      actorContext,
      groupJid,
      target,
      groupJid,
      durationToken || undefined,
      config,
      groups,
      groupMetadataByJid,
    );
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!unmute") {
    removeMute(target.userId, groupJid);
    await sock.sendMessage(groupJid, {
      text: `🔊 Unmuted ${formatUserSummary(target)} in ${formatGroupName(groupJid, groups)}
They can now send messages again.`,
    });
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!remove") {
    if (!(await ensureTargetNotProtected(sock, groupJid, target, groupJid, config, groupMetadataByJid, "remove"))) {
      logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "error");
      return true;
    }

    const liveParticipantJid = findParticipantJidForUser(target.userId, groupMetadataByJid.get(groupJid));
    if (!liveParticipantJid) {
      await sock.sendMessage(groupJid, {
        text: `❌ Couldn't find ${formatUserSummary(target)} in this group to remove.`,
      });
      logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "error");
      return true;
    }

    try {
      await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
      resetStrikes(target.userId, groupJid);
      clearReviewQueueEntry(target.userId, groupJid);
      await sock.sendMessage(groupJid, {
        text: `✅ Removed ${formatUserSummary(target)} from ${formatGroupName(groupJid, groups)}`,
      });
      logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    } catch {
      await sock.sendMessage(groupJid, {
        text: "❌ Failed to remove that member. Make sure the bot is an admin in this group.",
      });
      logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "error");
    }
    return true;
  }

  if (command === "!ban") {
    await handleBanCommand(
      sock,
      actorContext,
      groupJid,
      target,
      groupJid,
      rest,
      config,
      groupMetadataByJid,
    );
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strike") {
    await handleStrikeCommand(
      sock,
      actorContext,
      groupJid,
      target,
      groupJid,
      rest,
      config,
      groupMetadataByJid,
    );
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!pardon" || command === "!resetstrikes") {
    resetStrikes(target.userId, groupJid);
    clearReviewQueueEntry(target.userId, groupJid);
    await sock.sendMessage(groupJid, {
      text: `✅ Strikes cleared for ${formatUserSummary(target)}`,
    });
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!strikes") {
    const count = getActiveStrikes(target.userId, groupJid);
    await sock.sendMessage(groupJid, {
      text: `Strikes for ${formatUserSummary(target)} in ${formatGroupName(groupJid, groups)}: ${count}`,
    });
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  if (command === "!whois") {
    await sock.sendMessage(groupJid, {
      text: buildWhoisText(describeUser(target.userId)),
    });
    logAudit(actorContext, command, target.userId, quotedParticipant, groupJid, text, "success");
    return true;
  }

  return false;
}

export async function handleAuthorisedCommand(
  sock: WASocket,
  actor: ResolvedUser,
  text: string,
  config: Config,
  groups: Map<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<void> {
  const command = canonicalCommand(getCommandToken(text));
  if (!command.startsWith("!")) {
    return;
  }

  const replyJid = getReplyJidForActor(actor);
  const actorContext = getActorContext(actor, config);
  if (!actorContext) {
    if (replyJid) {
      const aliasLines = actor.knownAliases.length > 0
        ? actor.knownAliases.map((alias) => `• ${alias}`).join("\n")
        : "• none";
      await sock.sendMessage(replyJid, {
        text: `⛔ You're not authorised to use Fete Bot commands. Ignoring this command.

Seen as: ${formatUserSummary(actor)}
Aliases:
${aliasLines}`,
      });
    }
    return;
  }

  if (!replyJid) {
    return;
  }

  if (command === "!help") {
    await sock.sendMessage(replyJid, {
      text: actorContext.actorRole === "owner" ? `${HELP_MESSAGE}${OWNER_HELP_BLOCK}` : HELP_MESSAGE,
    });
    logAudit(actorContext, "!help", null, null, null, text, "success");
    return;
  }

  if (command === "!undo") {
    await handleUndoCommand(sock, replyJid, actorContext);
    logAudit(actorContext, "!undo", null, null, null, text, "success");
    return;
  }

  if (command === "!status") {
    const moderators = listModerators();
    const managedGroupJids = getManagedGroupJids(config, groups);
    const configuredGroups = managedGroupJids.map((jid) => `• ${formatGroupName(jid, groups)} (${jid})`);
    const groupSource = config.allowedGroupJids.length > 0 ? "config allowlist" : "joined groups";

    await sock.sendMessage(replyJid, {
      text: `Fete Bot Status

Version: ${VERSION}
Started: ${STARTED_AT}
Mode: ${config.dryRun ? "DRY RUN (not deleting)" : "LIVE (deleting messages)"}

Active in ${configuredGroups.length} group(s):
${configuredGroups.length > 0 ? configuredGroups.join("\n") : "• None configured"}

Watching ${managedGroupJids.length} group JIDs from ${groupSource}.
Owners: ${config.ownerJids.length} configured.
Moderators: ${moderators.length} configured.
Strikes issued today: ${getStrikesIssuedToday()}
Total active strikes: ${getTotalActiveStrikes()}
Total active bans: ${getTotalActiveBans()}
Total active mutes: ${getTotalActiveMutes()}
Forwarded messages seen today: ${getForwardedMessagesSeenToday()}`,
    });
    logAudit(actorContext, "!status", null, null, null, text, "success");
    return;
  }

  if (command === "!reviews") {
    const entries = listReviewQueueEntries();
    await sock.sendMessage(replyJid, {
      text: entries.length > 0
        ? `Pending review queue:\n\n${entries.map((entry, index) => `${index + 1}. ${buildReviewText(entry, groups)}`).join("\n\n")}`
        : "No pending review items right now.",
    });
    logAudit(actorContext, "!reviews", null, null, null, text, "success");
    return;
  }

  if (command === "!audit") {
    const limit = Number(text.trim().split(/\s+/)[1] ?? "20");
    const entries = getAuditEntries(Number.isFinite(limit) && limit > 0 ? limit : 20);
    const lines =
      entries.length > 0
        ? entries.map(
            (entry, index) =>
              `${index + 1}. ${entry.timestamp} ${entry.command} [${entry.result}]
   Actor: ${entry.actorUserId ? formatUserById(entry.actorUserId) : entry.actorJid ?? "n/a"} (${entry.actorRole})
   Target: ${entry.targetUserId ? formatUserById(entry.targetUserId) : entry.targetJid ?? "n/a"}
   Group: ${entry.groupJid ?? "n/a"}
   Input: ${entry.rawInput ?? ""}`,
          )
        : ["No audit entries found."];
    await sock.sendMessage(replyJid, { text: lines.join("\n\n") });
    logAudit(actorContext, "!audit", null, null, null, text, "success");
    return;
  }

  if (command === "!test" && text.trim().split(/\s+/).length > 1) {
    const candidate = text.trim().slice("!test".length).trim();
    const result = containsDisallowedUrl(candidate);
    await sock.sendMessage(replyJid, {
      text: result.found && result.reason
        ? `❌ Would block (reason: ${result.reason})\nWould send: "${previewWarningText(result.reason)}"`
        : "✅ Would allow",
    });
    logAudit(actorContext, "!test", null, null, null, text, "success");
    return;
  }

  if (command === "!test") {
    await sock.sendMessage(replyJid, { text: "Usage: !test {url}" });
    logAudit(actorContext, "!test", null, null, null, text, "error");
    return;
  }

  if (command === "!addmod") {
    if (actorContext.actorRole !== "owner") {
      await sock.sendMessage(replyJid, { text: "❌ Only owners can add moderators." });
      logAudit(actorContext, "!addmod", null, null, null, text, "error");
      return;
    }

    const parsed = parseTargetSpecifier(text);
    if (!parsed.targetIdentifier) {
      await sendInvalidIdentifier(sock, replyJid);
      logAudit(actorContext, "!addmod", null, null, null, text, "error");
      return;
    }

    const target = await resolveIdentifierTarget(parsed.targetIdentifier, selfJids);
    if (!target) {
      await sendIdentifierParseFailure(sock, replyJid, parsed.targetIdentifier);
      logAudit(actorContext, "!addmod", null, null, null, text, "error");
      return;
    }

    addModerator(target.userId, getActorReference(actorContext), parsed.rest || undefined);
    await sock.sendMessage(replyJid, {
      text: `✅ Added ${formatUserSummary(target)} as moderator
Note: ${parsed.rest.trim() || "none"}
They can now use all moderation commands.`,
    });
    logAudit(actorContext, "!addmod", target.userId, target.participantJid, null, text, "success");
    return;
  }

  if (command === "!removemod") {
    if (actorContext.actorRole !== "owner") {
      await sock.sendMessage(replyJid, { text: "❌ Only owners can remove moderators." });
      logAudit(actorContext, "!removemod", null, null, null, text, "error");
      return;
    }

    const parsed = parseTargetSpecifier(text);
    if (!parsed.targetIdentifier) {
      await sendInvalidIdentifier(sock, replyJid);
      logAudit(actorContext, "!removemod", null, null, null, text, "error");
      return;
    }

    const target = await resolveIdentifierTarget(parsed.targetIdentifier, selfJids);
    if (!target) {
      await sendIdentifierParseFailure(sock, replyJid, parsed.targetIdentifier);
      logAudit(actorContext, "!removemod", null, null, null, text, "error");
      return;
    }

    if (target.knownAliases.some((alias) => config.ownerJids.includes(alias))) {
      await sock.sendMessage(replyJid, {
        text: "❌ Can't remove an owner via commands. Change OWNER_JIDS and redeploy instead.",
      });
      logAudit(actorContext, "!removemod", target.userId, target.participantJid, null, text, "error");
      return;
    }

    removeModerator(target.userId);
    await sock.sendMessage(replyJid, {
      text: `✅ Removed ${formatUserSummary(target)} as moderator`,
    });
    logAudit(actorContext, "!removemod", target.userId, target.participantJid, null, text, "success");
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
              `• ${formatUserById(moderator.userId)} (added by ${formatActorReference({
                userId: moderator.addedByUserId,
                label: moderator.addedByLabel,
              })}, note: "${moderator.note ?? "none"}")`,
          )
        : ["• None"];

    await sock.sendMessage(replyJid, {
      text: `Fete Bot Moderators

Owners (config):
${ownerLines.join("\n")}

Moderators (database):
${moderatorLines.join("\n")}

Total: ${config.ownerJids.length + moderators.length} authorised users`,
    });
    logAudit(actorContext, "!mods", null, null, null, text, "success");
    return;
  }

  const parsed = parseCommandArgs(text);

  if (
    COMMANDS_WITH_TARGET.has(parsed.command) &&
    parsed.parseFailed
  ) {
    await sendInvalidIdentifier(sock, replyJid);
    logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "error");
    return;
  }

  if (isDestructiveCommand(parsed.command) && !checkDestructiveCommandRateLimit(actorContext.userId)) {
    await sock.sendMessage(replyJid, {
      text: "Slow down — you've run 10 commands in the last minute. Try again shortly.",
    });
    logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "error");
    return;
  }

  if (parsed.command === "!whois") {
    if (!parsed.targetIdentifier) {
      await sock.sendMessage(replyJid, { text: "Usage: !whois {identifier}" });
      logAudit(actorContext, parsed.command, null, null, null, text, "error");
      return;
    }

    const parsedIdentifier = parseIdentifierDetailed(parsed.targetIdentifier);
    if (!("alias" in parsedIdentifier)) {
      await sendIdentifierParseFailure(sock, replyJid, parsed.targetIdentifier);
      logAudit(actorContext, parsed.command, null, null, null, text, "error");
      return;
    }

    const found = findUserByIdentifier(parsed.targetIdentifier);
    await sock.sendMessage(replyJid, {
      text: buildWhoisText(found ? describeUser(found.userId) : null),
    });
    logAudit(actorContext, parsed.command, found?.userId ?? null, null, null, text, "success");
    return;
  }

  const target = parsed.targetIdentifier ? await resolveIdentifierTarget(parsed.targetIdentifier, selfJids) : null;

  if (
    COMMANDS_WITH_TARGET.has(parsed.command) &&
    parsed.command !== "!whois" &&
    !target
  ) {
    await sendIdentifierParseFailure(sock, replyJid, parsed.targetIdentifier);
    logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "error");
    return;
  }

  if (parsed.command === "!remove") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !remove {identifier} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    if (!(await ensureTargetNotProtectedAcrossGroups(sock, replyJid, target, groupJids, config, groupMetadataByJid, groups, "remove"))) {
      logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "error");
      return;
    }

    const removedFromGroupJids: string[] = [];
    const notPresentGroupJids: string[] = [];
    const failedGroupJids: string[] = [];
    for (const groupJid of groupJids) {
      const liveParticipantJid = findParticipantJidForUser(target.userId, groupMetadataByJid.get(groupJid));
      if (liveParticipantJid) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
          removedFromGroupJids.push(groupJid);
        } catch {
          failedGroupJids.push(groupJid);
        }
      } else {
        notPresentGroupJids.push(groupJid);
      }

      resetStrikes(target.userId, groupJid);
      clearReviewQueueEntry(target.userId, groupJid);
    }

    const resultLines =
      removedFromGroupJids.length > 0
        ? [`✅ Removed ${formatUserSummary(target)} from ${formatGroupList(removedFromGroupJids, groups)}`]
        : [`⚠️ ${formatUserSummary(target)} was not removed from any live group.`];
    if (notPresentGroupJids.length > 0) {
      resultLines.push(`Not currently present in: ${formatGroupList(notPresentGroupJids, groups)}`);
    }
    if (failedGroupJids.length > 0) {
      resultLines.push(`Failed to remove from: ${formatGroupList(failedGroupJids, groups)}. Make sure the bot is an admin there.`);
    }

    await sock.sendMessage(replyJid, {
      text: resultLines.join("\n"),
    });
    for (const groupJid of removedFromGroupJids) {
      await sock.sendMessage(groupJid, {
        text: "A member has been removed for repeated violations.",
      });
    }
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!pardon" || parsed.command === "!resetstrikes") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : `Usage: ${parsed.command} {identifier} {groupJid?}`,
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      resetStrikes(target.userId, groupJid);
      clearReviewQueueEntry(target.userId, groupJid);
    }

    await sock.sendMessage(replyJid, {
      text: `✅ Strikes cleared for ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strikes") {
    if (!target) {
      await sock.sendMessage(replyJid, { text: "Usage: !strikes {identifier}" });
      logAudit(actorContext, parsed.command, null, null, null, text, "error");
      return;
    }

    const strikeMap = new Map(
      getActiveStrikesAcrossGroups(target.userId).map((row) => [row.group_jid, row.count]),
    );
    const groupJids = Array.from(new Set([...getManagedGroupJids(config, groups), ...strikeMap.keys()]));
    const lines =
      groupJids.length > 0
        ? groupJids.map((groupJid) => `• ${formatGroupName(groupJid, groups)}: ${strikeMap.get(groupJid) ?? 0} active strikes`)
        : ["• No known groups"];

    await sock.sendMessage(replyJid, {
      text: `Strikes for ${formatUserSummary(target)}:\n${lines.join("\n")}`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, null, text, "success");
    return;
  }

  if (parsed.command === "!ban") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !ban {identifier} {reason?} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.length > 1 && !(await ensureTargetNotProtectedAcrossGroups(sock, replyJid, target, groupJids, config, groupMetadataByJid, groups, "ban"))) {
      logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "error");
      return;
    }

    const removedFromGroupJids: string[] = [];
    const failedRemovalGroupJids: string[] = [];
    for (const groupJid of groupJids) {
      addBan(target.userId, groupJid, getActorReference(actorContext), parsed.rest || undefined);
      clearReviewQueueEntry(target.userId, groupJid);
      const liveParticipantJid = findParticipantJidForUser(target.userId, groupMetadataByJid.get(groupJid));
      if (liveParticipantJid) {
        try {
          await sock.groupParticipantsUpdate(groupJid, [liveParticipantJid], "remove");
          removedFromGroupJids.push(groupJid);
        } catch {
          failedRemovalGroupJids.push(groupJid);
        }
      }
    }

    recordUndoAction(actorContext.userId, {
      type: "ban",
      targetUserId: target.userId,
      scopeLabel: formatGroupScope(groupJids, groups),
      expiresAt: Date.now() + 5 * 60 * 1000,
      undo: async () => {
        for (const groupJid of groupJids) {
          removeBan(target.userId, groupJid);
        }
      },
    });

    const resultLines = [
      `✅ Banned ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}
Reason: ${formatReason(parsed.rest)}
They will be auto-removed if they try to rejoin.`,
    ];
    if (removedFromGroupJids.length > 0) {
      resultLines.push(`Removed now from: ${formatGroupList(removedFromGroupJids, groups)}`);
    }
    if (failedRemovalGroupJids.length > 0) {
      resultLines.push(`Ban saved, but failed to remove now from: ${formatGroupList(failedRemovalGroupJids, groups)}. Make sure the bot is an admin there.`);
    }

    await sock.sendMessage(replyJid, {
      text: resultLines.join("\n"),
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unban") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !unban {identifier} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      removeBan(target.userId, groupJid);
    }

    await sock.sendMessage(replyJid, {
      text: `✅ Ban lifted for ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}
They can now rejoin the group.`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!bans") {
    const { groupJids, invalid, scopeLabel } = getBanListingTargets(parsed.groupJid, config, groups);
    if (invalid) {
      await sock.sendMessage(replyJid, {
        text: "❌ That group isn't one of this bot's managed groups.",
      });
      logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "error");
      return;
    }

    const sections = groupJids
      .map((groupJid) => ({ groupJid, bans: getBans(groupJid) }))
      .filter((section) => section.bans.length > 0);

    await sock.sendMessage(replyJid, {
      text: sections.length > 0
        ? `Active bans in ${scopeLabel}:\n\n${sections
            .map(({ groupJid, bans }) => {
              const lines = bans.map(
                (ban, index) =>
                  `${index + 1}. ${formatUserById(ban.userId)}
   Banned by: ${formatActorReference({ userId: ban.bannedByUserId, label: ban.bannedByLabel })}
   Reason: ${formatReason(ban.reason)}
   Date: ${ban.createdAt}`,
              );
              return `${formatGroupName(groupJid, groups)}:\n${lines.join("\n\n")}`;
            })
            .join("\n\n")}`
        : `No active bans in ${scopeLabel}`,
    });
    logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mute") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !mute {identifier} {duration?} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.length > 1 && !(await ensureTargetNotProtectedAcrossGroups(sock, replyJid, target, groupJids, config, groupMetadataByJid, groups, "mute"))) {
      logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "error");
      return;
    }

    const durationToken = parsed.rest.split(/\s+/)[0];
    const expiresAt = parseDuration(durationToken || undefined);
    for (const groupJid of groupJids) {
      addMute(target.userId, groupJid, getActorReference(actorContext), expiresAt, undefined);
    }

    recordUndoAction(actorContext.userId, {
      type: "mute",
      targetUserId: target.userId,
      scopeLabel: formatGroupScope(groupJids, groups),
      expiresAt: Date.now() + 5 * 60 * 1000,
      undo: async () => {
        for (const groupJid of groupJids) {
          removeMute(target.userId, groupJid);
        }
      },
    });

    await sock.sendMessage(replyJid, {
      text: `🔇 Muted ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}
Duration: ${expiresAt ? formatDurationLabel(durationToken) : "permanent"}
${expiresAt ? `Expires: ${formatDate(expiresAt.toISOString())}\n` : ""}Reason: none given`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!unmute") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !unmute {identifier} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      removeMute(target.userId, groupJid);
    }

    await sock.sendMessage(replyJid, {
      text: `🔊 Unmuted ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}
They can now send messages again.`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!mutes") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !mutes {groupJid?}",
      });
      logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "error");
      return;
    }

    const sections = groupJids
      .map((groupJid) => ({ groupJid, mutes: getActiveMutes(groupJid) }))
      .filter((section) => section.mutes.length > 0);

    await sock.sendMessage(replyJid, {
      text: sections.length > 0
        ? `Active mutes in ${formatGroupScope(groupJids, groups)}:\n\n${sections
            .map(({ groupJid, mutes }) => {
              const lines = mutes.map(
                (mute, index) =>
                  `${index + 1}. ${formatUserById(mute.userId)}
   Muted by: ${formatActorReference({ userId: mute.mutedByUserId, label: mute.mutedByLabel })}
   Reason: ${formatReason(mute.reason)}
   Expires: ${formatDate(mute.expiresAt)}`,
              );
              return `${formatGroupName(groupJid, groups)}:\n${lines.join("\n\n")}`;
            })
            .join("\n\n")}`
        : `No active mutes in ${formatGroupScope(groupJids, groups)}`,
    });
    logAudit(actorContext, parsed.command, null, null, parsed.groupJid, text, "success");
    return;
  }

  if (parsed.command === "!strike") {
    const { groupJids, invalid } = resolveGroupTargets(parsed.groupJid, config, groups);
    if (!target || groupJids.length === 0) {
      await sock.sendMessage(replyJid, {
        text: invalid ? "❌ That group isn't one of this bot's managed groups." : "Usage: !strike {identifier} {reason?} {groupJid?}",
      });
      logAudit(actorContext, parsed.command, target?.userId ?? null, target?.participantJid ?? null, parsed.groupJid, text, "error");
      return;
    }

    if (groupJids.length > 1 && !(await ensureTargetNotProtectedAcrossGroups(sock, replyJid, target, groupJids, config, groupMetadataByJid, groups, "strike"))) {
      logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "error");
      return;
    }

    for (const groupJid of groupJids) {
      addStrike(target.userId, groupJid, parsed.rest || "manual strike", randomUUID());
    }

    recordUndoAction(actorContext.userId, {
      type: "strike",
      targetUserId: target.userId,
      scopeLabel: formatGroupScope(groupJids, groups),
      expiresAt: Date.now() + 5 * 60 * 1000,
      undo: async () => {
        for (const groupJid of groupJids) {
          removeLatestStrike(target.userId, groupJid);
        }
      },
    });

    await sock.sendMessage(replyJid, {
      text: `⚠️ Added a strike for ${formatUserSummary(target)} in ${formatGroupScope(groupJids, groups)}.`,
    });
    logAudit(actorContext, parsed.command, target.userId, target.participantJid, parsed.groupJid, text, "success");
  }
}
