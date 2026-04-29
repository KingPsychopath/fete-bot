import { config } from "./config.js";
import {
  addBan,
  addMute,
  addModerator,
  closeDb,
  clearReviewQueueEntry,
  flushDb,
  GLOBAL_MODERATION_GROUP_JID,
  getActiveMutes,
  getActiveStrikesAcrossGroups,
  getAuditEntries,
  getBanGroupJids,
  getBans,
  getDeletedMessageLogs,
  initDb,
  isModeratorUser,
  listModerators,
  removeAllBans,
  removeAllMutes,
  removeBan,
  removeModerator,
  removeMute,
  resetAllStrikes,
  resetStrikes,
  type ActorReference,
} from "./db.js";
import {
  describeUser,
  findUserByIdentifier,
  getShortUserId,
  mergeUserAliases,
  parseIdentifierDetailed,
  resolveTargetFromIdentifier,
  type UserSummary,
} from "./identity.js";
import { formatAuditGroupLabel } from "./auditFormat.js";
import { containsDisallowedUrl } from "./linkChecker.js";
import { formatJidForDisplay, parseDuration } from "./utils.js";

const HELP_TEXT = `Fete Bot Local Admin CLI

Usage:
  pnpm admin:cli help
  pnpm admin:cli status
  pnpm admin:cli whois <identifier>
  pnpm admin:cli identity link <primaryIdentifier> <aliasIdentifier>
  pnpm admin:cli test-url <url>
  pnpm admin:cli ban <identifier> [groupJid] [reason...]
  pnpm admin:cli mute <identifier> [groupJid] [duration] [reason...]
  pnpm admin:cli reset-all [groupJid]
  pnpm admin:cli db flush --yes

Moderators:
  pnpm admin:cli mods list
  pnpm admin:cli mods add <identifier> [note...]
  pnpm admin:cli mods remove <identifier>

Strikes:
  pnpm admin:cli strikes list <identifier>
  pnpm admin:cli strikes reset <identifier> [groupJid]
  pnpm admin:cli strikes clear <identifier> [groupJid]
  pnpm admin:cli strikes reset-all [groupJid]
  pnpm admin:cli strikes clear-all [groupJid]

Bans:
  pnpm admin:cli bans list [groupJid]
  pnpm admin:cli bans add <identifier> [groupJid] [reason...]
  pnpm admin:cli bans reset <identifier> [groupJid]
  pnpm admin:cli bans clear <identifier> [groupJid]
  pnpm admin:cli bans reset-all [groupJid]
  pnpm admin:cli bans clear-all [groupJid]

Mutes:
  pnpm admin:cli mutes list <groupJid>
  pnpm admin:cli mutes add <identifier> [groupJid] [duration] [reason...]
  pnpm admin:cli mutes reset <identifier> [groupJid]
  pnpm admin:cli mutes clear <identifier> [groupJid]
  pnpm admin:cli mutes reset-all [groupJid]
  pnpm admin:cli mutes clear-all [groupJid]

Audit:
  pnpm admin:cli audit [limit]

Deleted messages:
  pnpm admin:cli deleted [limit] [reason...]
  pnpm admin:cli deleted 25 not-in-allowlist

Database:
  pnpm admin:cli db flush --yes`;

const fail = (message: string): never => {
  console.error(`Error: ${message}`);
  process.exit(1);
};

const formatIdentifierFailure = (input: string): string => {
  const parsed = parseIdentifierDetailed(input);
  if ("alias" in parsed) {
    return `could not parse "${input}" as a WhatsApp user identifier`;
  }

  return parsed.hint
    ? `could not parse "${input}" as a WhatsApp user identifier (${parsed.hint})`
    : `could not parse "${input}" as a WhatsApp user identifier`;
};

const LOCAL_CLI_ACTOR: ActorReference = {
  userId: null,
  label: "local-cli",
};

const formatUserSummary = (summary: UserSummary | null): string => {
  if (!summary) {
    return "unknown user";
  }

  const phoneAlias = summary.aliases.find((alias) => alias.aliasType === "phone")?.alias ?? null;
  const lidAlias = summary.aliases.find((alias) => alias.aliasType === "lid")?.alias ?? null;
  const primaryAlias = phoneAlias ?? lidAlias ?? summary.userId;
  const primaryLabel = primaryAlias.includes("@") ? formatJidForDisplay(primaryAlias) : primaryAlias;
  const displayName = summary.displayName?.trim() || null;

  if (displayName) {
    return `${displayName} (${primaryLabel}, ${summary.shortId})`;
  }

  return `${primaryLabel} (${summary.shortId})`;
};

const resolveWritableUser = async (input: string | undefined): Promise<UserSummary> => {
  const value = input ?? fail("missing user identifier");
  const resolved = await resolveTargetFromIdentifier(value, new Set());
  if (!resolved) {
    fail(formatIdentifierFailure(value));
  }
  const ensuredResolved = resolved ?? fail(formatIdentifierFailure(value));

  return {
    userId: ensuredResolved.userId,
    shortId: ensuredResolved.shortId,
    createdAt: ensuredResolved.createdAt,
    displayName: ensuredResolved.displayName,
    notes: ensuredResolved.notes,
    mergedInto: ensuredResolved.mergedInto,
    aliases: ensuredResolved.aliases,
  };
};

const resolveExistingUser = (input: string | undefined): UserSummary => {
  const value = input ?? fail("missing user identifier");
  const found = findUserByIdentifier(value);
  if (!found) {
    fail(`no user found for "${value}"`);
  }

  return found ?? fail(`no user found for "${value}"`);
};

const requireGroupJid = (input: string | undefined): string => {
  const value = input ?? fail("group JID must be provided in raw WhatsApp format, e.g. 120363...@g.us");
  if (!value.endsWith("@g.us")) {
    fail("group JID must be provided in raw WhatsApp format, e.g. 120363...@g.us");
  }

  return value;
};

const resolveCliGroupTargets = (input: string | undefined): string[] => [
  input ? requireGroupJid(input) : GLOBAL_MODERATION_GROUP_JID,
];

const formatCliGroupScope = (groupJids: readonly string[]): string =>
  groupJids.length === 1 && groupJids[0] === GLOBAL_MODERATION_GROUP_JID
    ? "all groups"
    : groupJids[0] ?? "unknown group";

const splitOptionalGroupJid = (parts: string[]): { groupJidInput: string | undefined; rest: string[] } => {
  const [first, ...remaining] = parts;
  if (first?.endsWith("@g.us")) {
    return { groupJidInput: first, rest: remaining };
  }

  return { groupJidInput: undefined, rest: parts };
};

const isOwnerUser = (user: UserSummary): boolean => user.aliases.some((alias) => config.ownerJids.includes(alias.alias));

const requireModerationTarget = (user: UserSummary, action: "ban" | "mute"): void => {
  if (isOwnerUser(user) || isModeratorUser(user.userId)) {
    fail(`cannot ${action} an owner or moderator via CLI`);
  }
};

const isDurationToken = (input: string | undefined): boolean => {
  if (!input) {
    return false;
  }

  return /^(?:\d+[mhd]|perm|permanent)$/i.test(input.trim());
};

const printStatus = (): void => {
  const moderators = listModerators();
  console.log("Fete Bot Local CLI");
  console.log("");
  console.log(`Dry run: ${config.dryRun}`);
  console.log(`Owners: ${config.ownerJids.length}`);
  console.log(`Moderators: ${moderators.length}`);
  console.log(`Allowed groups: ${config.allowedGroupJids.length}`);

  if (config.ownerJids.length > 0) {
    console.log("");
    console.log("Owner JIDs:");
    for (const ownerJid of config.ownerJids) {
      console.log(`- ${formatJidForDisplay(ownerJid)}`);
    }
  }

  if (config.allowedGroupJids.length > 0) {
    console.log("");
    console.log("Allowed groups:");
    for (const groupJid of config.allowedGroupJids) {
      console.log(`- ${groupJid}`);
    }
  }
};

const listMods = (): void => {
  const moderators = listModerators();

  console.log("Owners:");
  if (config.ownerJids.length === 0) {
    console.log("- None configured");
  } else {
    for (const ownerJid of config.ownerJids) {
      console.log(`- ${formatJidForDisplay(ownerJid)}`);
    }
  }

  console.log("");
  console.log("Moderators:");
  if (moderators.length === 0) {
    console.log("- None");
    return;
  }

  for (const moderator of moderators) {
    console.log(
      `- ${formatUserSummary(describeUser(moderator.userId))} | added by ${
        moderator.addedByUserId ? formatUserSummary(describeUser(moderator.addedByUserId)) : moderator.addedByLabel
      } | note: ${moderator.note ?? "none"} | at: ${moderator.addedAt}`,
    );
  }
};

const addMod = async (input: string | undefined, noteParts: string[]): Promise<void> => {
  const user = await resolveWritableUser(input);
  const note = noteParts.join(" ").trim() || undefined;
  addModerator(user.userId, LOCAL_CLI_ACTOR, note);
  console.log(`Added moderator: ${formatUserSummary(user)}`);
  console.log(`Note: ${note ?? "none"}`);
};

const removeMod = async (input: string | undefined): Promise<void> => {
  const user = await resolveWritableUser(input);
  if (user.aliases.some((alias) => config.ownerJids.includes(alias.alias))) {
    fail("cannot remove an owner via CLI moderator removal");
  }

  removeModerator(user.userId);
  console.log(`Removed moderator: ${formatUserSummary(user)}`);
};

const linkIdentityAliases = async (
  primaryInput: string | undefined,
  aliasInput: string | undefined,
): Promise<void> => {
  const primary = primaryInput ?? fail("missing primary identifier");
  const alias = aliasInput ?? fail("missing alias identifier");
  const primaryParsed = parseIdentifierDetailed(primary);
  const aliasParsed = parseIdentifierDetailed(alias);
  const primaryAlias = "alias" in primaryParsed ? primaryParsed.alias : fail(formatIdentifierFailure(primary));
  const aliasAlias = "alias" in aliasParsed ? aliasParsed.alias : fail(formatIdentifierFailure(alias));

  await resolveTargetFromIdentifier(primary, new Set());
  await resolveTargetFromIdentifier(alias, new Set());
  const linkedResult = await mergeUserAliases([primaryAlias, aliasAlias], new Set(), "manual_admin");
  const linked = linkedResult ?? fail(`could not link ${primary} and ${alias}`);

  console.log(`Linked identity: ${formatUserSummary(linked)}`);
  console.log("Aliases:");
  for (const userAlias of linked.aliases) {
    console.log(`- ${userAlias.aliasType}: ${userAlias.alias}`);
  }
};

const listStrikes = async (input: string | undefined): Promise<void> => {
  const user = resolveExistingUser(input);
  const rows = getActiveStrikesAcrossGroups(user.userId);
  if (rows.length === 0) {
    console.log(`No active strikes for ${formatUserSummary(user)}`);
    return;
  }

  console.log(`Active strikes for ${formatUserSummary(user)}:`);
  for (const row of rows) {
    console.log(`- ${row.group_jid}: ${row.count}`);
  }
};

const resetUserStrikes = async (input: string | undefined, groupJid?: string): Promise<void> => {
  const user = await resolveWritableUser(input);

  if (groupJid) {
    resetStrikes(user.userId, requireGroupJid(groupJid));
    console.log(`Reset strikes for ${formatUserSummary(user)} in ${groupJid}`);
    return;
  }

  if (config.allowedGroupJids.length === 0) {
    fail("no allowed groups configured; pass an explicit group JID");
  }

  for (const allowedGroupJid of config.allowedGroupJids) {
    resetStrikes(user.userId, allowedGroupJid);
  }

  console.log(`Reset strikes for ${formatUserSummary(user)} across ${config.allowedGroupJids.length} configured group(s)`);
};

const resetEveryoneStrikes = (groupJid?: string): void => {
  if (groupJid) {
    const resolvedGroupJid = requireGroupJid(groupJid);
    resetAllStrikes(resolvedGroupJid);
    console.log(`Reset strikes for everyone in ${resolvedGroupJid}`);
    return;
  }

  resetAllStrikes();
  console.log("Reset strikes for everyone across all groups");
};

const resetAllState = (groupJidInput?: string): void => {
  if (groupJidInput) {
    const groupJid = requireGroupJid(groupJidInput);
    resetAllStrikes(groupJid);
    removeAllBans(groupJid);
    removeAllMutes(groupJid);
    console.log(`Reset all strikes, bans, and mutes in ${groupJid}`);
    return;
  }

  resetAllStrikes();
  removeAllBans();
  removeAllMutes();
  console.log("Reset all strikes, bans, and mutes across all groups");
};

const listBans = (groupJidInput: string | undefined): void => {
  if (groupJidInput) {
    const groupJid = requireGroupJid(groupJidInput);
    const bans = getBans(groupJid);
    if (bans.length === 0) {
      console.log(`No bans in ${groupJid}`);
      return;
    }

    console.log(`Bans in ${groupJid}:`);
    for (const ban of bans) {
      console.log(
        `- ${formatUserSummary(describeUser(ban.userId))} | by ${
          ban.bannedByUserId ? formatUserSummary(describeUser(ban.bannedByUserId)) : ban.bannedByLabel
        } | reason: ${ban.reason ?? "none"} | at: ${ban.createdAt}`,
      );
    }
    return;
  }

  const groupJids = getBanGroupJids();
  if (groupJids.length === 0) {
    console.log("No bans across all groups");
    return;
  }

  console.log("Bans across all groups:");
  for (const groupJid of groupJids) {
    const bans = getBans(groupJid);
    console.log("");
    console.log(`${groupJid}:`);
    for (const ban of bans) {
      console.log(
        `- ${formatUserSummary(describeUser(ban.userId))} | by ${
          ban.bannedByUserId ? formatUserSummary(describeUser(ban.bannedByUserId)) : ban.bannedByLabel
        } | reason: ${ban.reason ?? "none"} | at: ${ban.createdAt}`,
      );
    }
  }
};

const addUserBan = async (
  input: string | undefined,
  groupJidInput: string | undefined,
  reasonParts: string[],
): Promise<void> => {
  const user = await resolveWritableUser(input);
  requireModerationTarget(user, "ban");
  const groupJids = resolveCliGroupTargets(groupJidInput);
  const reason = reasonParts.join(" ").trim() || undefined;

  for (const groupJid of groupJids) {
    addBan(user.userId, groupJid, LOCAL_CLI_ACTOR, reason);
    clearReviewQueueEntry(user.userId, groupJid);
  }

  console.log(`Banned ${formatUserSummary(user)} in ${formatCliGroupScope(groupJids)}`);
  console.log(`Reason: ${reason ?? "none"}`);
  console.log(
    groupJids.includes(GLOBAL_MODERATION_GROUP_JID)
      ? "The running bot will enforce this across all joined groups."
      : "They will be auto-removed if they try to rejoin.",
  );
};

const resetBan = async (input: string | undefined, groupJidInput: string | undefined): Promise<void> => {
  const user = await resolveWritableUser(input);
  const groupJids = resolveCliGroupTargets(groupJidInput);
  for (const groupJid of groupJids) {
    removeBan(user.userId, groupJid);
  }
  console.log(`Reset ban for ${formatUserSummary(user)} in ${formatCliGroupScope(groupJids)}`);
};

const resetAllBans = (groupJidInput?: string): void => {
  if (groupJidInput) {
    const groupJid = requireGroupJid(groupJidInput);
    removeAllBans(groupJid);
    console.log(`Reset all bans in ${groupJid}`);
    return;
  }

  removeAllBans();
  console.log("Reset all bans across all groups");
};

const listMutes = (groupJidInput: string | undefined): void => {
  const groupJid = requireGroupJid(groupJidInput);
  const mutes = getActiveMutes(groupJid);
  if (mutes.length === 0) {
    console.log(`No active mutes in ${groupJid}`);
    return;
  }

  console.log(`Active mutes in ${groupJid}:`);
  for (const mute of mutes) {
    console.log(
      `- ${formatUserSummary(describeUser(mute.userId))} | by ${
        mute.mutedByUserId ? formatUserSummary(describeUser(mute.mutedByUserId)) : mute.mutedByLabel
      } | reason: ${mute.reason ?? "none"} | expires: ${mute.expiresAt ?? "permanent"}`,
    );
  }
};

const addUserMute = async (
  input: string | undefined,
  groupJidInput: string | undefined,
  durationInput: string | undefined,
  reasonParts: string[],
): Promise<void> => {
  const user = await resolveWritableUser(input);
  requireModerationTarget(user, "mute");
  const groupJids = resolveCliGroupTargets(groupJidInput);
  const expiresAt = parseDuration(durationInput);
  const reason = reasonParts.join(" ").trim() || undefined;

  for (const groupJid of groupJids) {
    addMute(user.userId, groupJid, LOCAL_CLI_ACTOR, expiresAt, reason);
  }

  console.log(`${expiresAt ? "Muted" : "Permanently muted"} ${formatUserSummary(user)} in ${formatCliGroupScope(groupJids)}`);
  console.log(`Duration: ${expiresAt ? durationInput ?? "24h" : "permanent"}`);
  if (expiresAt) {
    console.log(`Expires: ${expiresAt.toISOString()}`);
  }
  console.log(`Reason: ${reason ?? "none"}`);
  console.log("Their messages will be silently deleted until lifted.");
};

const resetMute = async (input: string | undefined, groupJidInput: string | undefined): Promise<void> => {
  const user = await resolveWritableUser(input);
  const groupJids = resolveCliGroupTargets(groupJidInput);
  for (const groupJid of groupJids) {
    removeMute(user.userId, groupJid);
  }
  console.log(`Reset mute for ${formatUserSummary(user)} in ${formatCliGroupScope(groupJids)}`);
};

const resetAllMutes = (groupJidInput?: string): void => {
  if (groupJidInput) {
    const groupJid = requireGroupJid(groupJidInput);
    removeAllMutes(groupJid);
    console.log(`Reset all mutes in ${groupJid}`);
    return;
  }

  removeAllMutes();
  console.log("Reset all mutes across all groups");
};

const showAudit = (limitInput?: string): void => {
  const limit = Number(limitInput ?? "20");
  const entries = getAuditEntries(Number.isFinite(limit) && limit > 0 ? limit : 20);
  if (entries.length === 0) {
    console.log("No audit entries found");
    return;
  }

  for (const entry of entries) {
    console.log(
      `- ${entry.timestamp} | ${entry.command} | ${entry.result} | actor: ${
        entry.actorUserId ? formatUserSummary(describeUser(entry.actorUserId)) : entry.actorJid ?? "n/a"
      } (${entry.actorRole}) | target: ${
        entry.targetUserId ? formatUserSummary(describeUser(entry.targetUserId)) : entry.targetJid ?? "n/a"
      } | group: ${formatAuditGroupLabel(entry)}`,
    );
  }
};

const normaliseDeletedReason = (input: string): string | undefined => {
  const trimmed = input.trim();
  if (!trimmed || trimmed === "all") {
    return undefined;
  }

  if (trimmed === "not-in-allowlist" || trimmed === "social" || trimmed === "profile") {
    return "not in allowlist";
  }

  return trimmed;
};

const showDeletedMessages = (limitInput?: string, reasonParts: string[] = []): void => {
  const limit = Number(limitInput ?? "20");
  const safeLimit = Number.isFinite(limit) && limit > 0 ? limit : 20;
  const reason = normaliseDeletedReason(reasonParts.join(" "));
  const entries = getDeletedMessageLogs(safeLimit, reason);

  if (entries.length === 0) {
    console.log(reason ? `No deleted messages found for reason: ${reason}` : "No deleted messages found");
    return;
  }

  for (const entry of entries) {
    const sender = entry.pushName ?? entry.participantJid ?? entry.userId ?? "unknown";
    console.log(`id: ${entry.id}`);
    console.log(`time: ${entry.timestamp}`);
    console.log(`group: ${entry.groupJid}`);
    console.log(`sender: ${sender}`);
    if (entry.userId && entry.userId !== sender) {
      console.log(`user: ${entry.userId}`);
    }
    console.log(`reason: ${entry.reason ?? "unknown"}`);
    console.log(`url: ${entry.urlFound ?? "none"}`);
    console.log("message:");
    console.log(entry.messageText?.trim() || "(no message text recorded)");
    console.log("---");
  }
};

const showWhois = (input: string | undefined): void => {
  const user = resolveExistingUser(input);
  const summary = describeUser(user.userId);
  if (!summary) {
    fail("no user found");
  }
  const ensuredSummary = summary ?? fail("no user found");

  const aliasLines = ensuredSummary.aliases.map((alias) => `- ${alias.aliasType}: ${alias.alias}`);
  const mergeLines =
    ensuredSummary.mergeHistory.length > 0
      ? ensuredSummary.mergeHistory.map((entry) => `- ${entry.reason}: survivor=${entry.survivorUserId} merged=${entry.mergedUserId}`)
      : ["- none"];

  console.log(`User ID: ${ensuredSummary.userId}`);
  console.log(`Short ID: ${ensuredSummary.shortId}`);
  console.log(`Display name: ${ensuredSummary.displayName ?? "unknown"}`);
  console.log(`Merged into: ${ensuredSummary.mergedInto ?? "active"}`);
  console.log("Aliases:");
  for (const line of aliasLines) {
    console.log(line);
  }
  console.log("Merge history:");
  for (const line of mergeLines) {
    console.log(line);
  }
};

const testUrl = (url: string | undefined): void => {
  const candidateUrl = url ?? fail("missing URL");
  const result = containsDisallowedUrl(candidateUrl);
  if (!result.found) {
    console.log("ALLOW");
    return;
  }

  console.log("BLOCK");
  console.log(`Reason: ${result.reason ?? "unknown"}`);
  console.log(`URL: ${result.url ?? candidateUrl}`);
};

const flushDatabase = (confirmationFlag: string | undefined): void => {
  if (confirmationFlag !== "--yes") {
    fail('database flush is destructive; rerun with "pnpm admin:cli db flush --yes"');
  }

  flushDb();
  console.log("Flushed SQLite database and recreated schema version 2");
};

const initDbOrExit = (): void => {
  try {
    initDb();
  } catch (dbError) {
    const message = dbError instanceof Error ? dbError.message : String(dbError);

    if (message.includes("compiled against a different Node.js version")) {
      fail(
        "SQLite native module is built for a different Node.js version. Run this repo with the pinned toolchain, for example: mise exec -- pnpm admin:cli ...",
      );
    }

    fail(`failed to initialise SQLite: ${message}`);
  }
};

const main = async (): Promise<void> => {
  try {
    const [command, subcommand, ...rest] = process.argv.slice(2);

    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.log(HELP_TEXT);
      return;
    }

    if (command === "test-url") {
      testUrl(subcommand);
      return;
    }

    initDbOrExit();

    if (command === "status") {
      printStatus();
      return;
    }

    if (command === "whois") {
      showWhois(subcommand);
      return;
    }

    if (command === "identity" && subcommand === "link") {
      await linkIdentityAliases(rest[0], rest[1]);
      return;
    }

    if (command === "ban") {
      const { groupJidInput, rest: banRest } = splitOptionalGroupJid(rest);
      await addUserBan(subcommand, groupJidInput, banRest);
      return;
    }

    if (command === "mute") {
      const { groupJidInput, rest: muteRest } = splitOptionalGroupJid(rest);
      const durationInput = isDurationToken(muteRest[0]) ? muteRest[0] : undefined;
      const reasonStartIndex = durationInput ? 1 : 0;
      await addUserMute(subcommand, groupJidInput, durationInput, muteRest.slice(reasonStartIndex));
      return;
    }

    if (command === "reset-all" || command === "clear-all") {
      resetAllState(subcommand);
      return;
    }

    if (command === "mods" && subcommand === "list") {
      listMods();
      return;
    }

    if (command === "mods" && subcommand === "add") {
      await addMod(rest[0], rest.slice(1));
      return;
    }

    if (command === "mods" && subcommand === "remove") {
      await removeMod(rest[0]);
      return;
    }

    if (command === "strikes" && subcommand === "list") {
      await listStrikes(rest[0]);
      return;
    }

    if (command === "strikes" && (subcommand === "reset" || subcommand === "clear")) {
      await resetUserStrikes(rest[0], rest[1]);
      return;
    }

    if (command === "strikes" && (subcommand === "reset-all" || subcommand === "clear-all")) {
      resetEveryoneStrikes(rest[0]);
      return;
    }

    if (command === "bans" && subcommand === "list") {
      listBans(rest[0]);
      return;
    }

    if (command === "bans" && subcommand === "add") {
      const { groupJidInput, rest: banRest } = splitOptionalGroupJid(rest.slice(1));
      await addUserBan(rest[0], groupJidInput, banRest);
      return;
    }

    if (command === "bans" && (subcommand === "reset" || subcommand === "clear")) {
      await resetBan(rest[0], rest[1]);
      return;
    }

    if (command === "bans" && (subcommand === "reset-all" || subcommand === "clear-all")) {
      resetAllBans(rest[0]);
      return;
    }

    if (command === "mutes" && subcommand === "list") {
      listMutes(rest[0]);
      return;
    }

    if (command === "mutes" && subcommand === "add") {
      const { groupJidInput, rest: muteRest } = splitOptionalGroupJid(rest.slice(1));
      const durationInput = isDurationToken(muteRest[0]) ? muteRest[0] : undefined;
      const reasonStartIndex = durationInput ? 1 : 0;
      await addUserMute(rest[0], groupJidInput, durationInput, muteRest.slice(reasonStartIndex));
      return;
    }

    if (command === "mutes" && (subcommand === "reset" || subcommand === "clear")) {
      await resetMute(rest[0], rest[1]);
      return;
    }

    if (command === "mutes" && (subcommand === "reset-all" || subcommand === "clear-all")) {
      resetAllMutes(rest[0]);
      return;
    }

    if (command === "audit") {
      showAudit(subcommand);
      return;
    }

    if (command === "deleted") {
      showDeletedMessages(subcommand, rest);
      return;
    }

    if (command === "db" && subcommand === "flush") {
      flushDatabase(rest[0]);
      return;
    }

    fail(`unknown command: ${[command, subcommand].filter(Boolean).join(" ")} (run "pnpm admin:cli help" for usage)`);
  } finally {
    closeDb();
  }
};

void main();
