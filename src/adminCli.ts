import { config } from "./config.js";
import {
  addModerator,
  closeDb,
  getActiveMutes,
  getActiveStrikesAcrossGroups,
  getAuditEntries,
  getBans,
  initDb,
  listModerators,
  removeAllBans,
  removeAllMutes,
  removeBan,
  removeMute,
  removeModerator,
  resetAllStrikes,
  resetStrikes,
} from "./db.js";
import { containsDisallowedUrl } from "./linkChecker.js";
import { formatJidForDisplay, parseToJid } from "./utils.js";

const HELP_TEXT = `Fete Bot Local Admin CLI

Usage:
  pnpm admin:cli help
  pnpm admin:cli status
  pnpm admin:cli test-url <url>

  pnpm admin:cli mods list
  pnpm admin:cli mods add <number|jid> [note...]
  pnpm admin:cli mods remove <number|jid>

  pnpm admin:cli strikes list <number|jid>
  pnpm admin:cli strikes reset <number|jid> [groupJid]
  pnpm admin:cli strikes reset-all [groupJid]

  pnpm admin:cli bans list <groupJid>
  pnpm admin:cli bans reset <number|jid> <groupJid>
  pnpm admin:cli bans reset-all [groupJid]
  pnpm admin:cli mutes list <groupJid>
  pnpm admin:cli mutes reset <number|jid> <groupJid>
  pnpm admin:cli mutes reset-all [groupJid]
  pnpm admin:cli audit [limit]

Notes:
  - This CLI is local-only and talks directly to ./data/bot.db
  - It is intended for testing and maintenance, not remote administration
  - For phone numbers, both UK local and international formats are accepted`;

const fail = (message: string): never => {
  console.error(`Error: ${message}`);
  process.exit(1);
};

const parseUserInputToJid = (input: string | undefined): string => {
  const value = input ?? fail("missing user JID or phone number");
  const jid = parseToJid(value);
  if (!jid) {
    fail(`could not parse "${value}" as a WhatsApp user JID`);
  }

  return jid ?? fail(`could not parse "${value}" as a WhatsApp user JID`);
};

const requireGroupJid = (input: string | undefined): string => {
  const value = input ?? fail("group JID must be provided in raw WhatsApp format, e.g. 120363...@g.us");
  if (!value.endsWith("@g.us")) {
    fail("group JID must be provided in raw WhatsApp format, e.g. 120363...@g.us");
  }

  return value;
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
      `- ${formatJidForDisplay(moderator.jid)} | added by ${formatJidForDisplay(
        moderator.addedBy,
      )} | note: ${moderator.note ?? "none"} | at: ${moderator.addedAt}`,
    );
  }
};

const addMod = (input: string | undefined, noteParts: string[]): void => {
  const jid = parseUserInputToJid(input);
  const note = noteParts.join(" ").trim() || undefined;
  addModerator(jid, "local-cli", note);
  console.log(`Added moderator: ${jid}`);
  console.log(`Note: ${note ?? "none"}`);
};

const removeMod = (input: string | undefined): void => {
  const jid = parseUserInputToJid(input);
  if (config.ownerJids.includes(jid)) {
    fail("cannot remove an owner via CLI moderator removal");
  }

  removeModerator(jid);
  console.log(`Removed moderator: ${jid}`);
};

const listStrikes = (input: string | undefined): void => {
  const jid = parseUserInputToJid(input);
  const rows = getActiveStrikesAcrossGroups(jid);

  if (rows.length === 0) {
    console.log(`No active strikes for ${jid}`);
    return;
  }

  console.log(`Active strikes for ${jid}:`);
  for (const row of rows) {
    console.log(`- ${row.group_jid}: ${row.count}`);
  }
};

const resetUserStrikes = (input: string | undefined, groupJid?: string): void => {
  const jid = parseUserInputToJid(input);

  if (groupJid) {
    resetStrikes(jid, requireGroupJid(groupJid));
    console.log(`Reset strikes for ${jid} in ${groupJid}`);
    return;
  }

  if (config.allowedGroupJids.length === 0) {
    fail("no allowed groups configured; pass an explicit group JID");
  }

  for (const allowedGroupJid of config.allowedGroupJids) {
    resetStrikes(jid, allowedGroupJid);
  }

  console.log(`Reset strikes for ${jid} across ${config.allowedGroupJids.length} configured group(s)`);
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

const listBans = (groupJidInput: string | undefined): void => {
  const groupJid = requireGroupJid(groupJidInput);
  const bans = getBans(groupJid);

  if (bans.length === 0) {
    console.log(`No bans in ${groupJid}`);
    return;
  }

  console.log(`Bans in ${groupJid}:`);
  for (const ban of bans) {
    console.log(
      `- ${ban.userJid} | by ${ban.bannedBy} | reason: ${ban.reason ?? "none"} | at: ${ban.timestamp}`,
    );
  }
};

const resetBan = (input: string | undefined, groupJidInput: string | undefined): void => {
  const jid = parseUserInputToJid(input);
  const groupJid = requireGroupJid(groupJidInput);
  removeBan(jid, groupJid);
  console.log(`Reset ban for ${jid} in ${groupJid}`);
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
      `- ${mute.userJid} | by ${mute.mutedBy} | reason: ${mute.reason ?? "none"} | expires: ${
        mute.expiresAt ?? "permanent"
      }`,
    );
  }
};

const resetMute = (input: string | undefined, groupJidInput: string | undefined): void => {
  const jid = parseUserInputToJid(input);
  const groupJid = requireGroupJid(groupJidInput);
  removeMute(jid, groupJid);
  console.log(`Reset mute for ${jid} in ${groupJid}`);
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
      `- ${entry.timestamp} | ${entry.command} | ${entry.result} | actor: ${entry.actorJid} (${entry.actorRole}) | target: ${
        entry.targetJid ?? "n/a"
      } | group: ${entry.groupJid ?? "n/a"}`,
    );
  }
};

const testUrl = (url: string | undefined): void => {
  const candidateUrl = url ?? fail("missing URL");
  const result = containsDisallowedUrl(candidateUrl);
  if (!result.found) {
    console.log("ALLOW");
    return;
  }

  console.log(`BLOCK`);
  console.log(`Reason: ${result.reason ?? "unknown"}`);
  console.log(`URL: ${result.url ?? candidateUrl}`);
};

const main = (): void => {
  initDb();

  try {
    const [command, subcommand, ...rest] = process.argv.slice(2);

    if (!command || command === "help" || command === "--help" || command === "-h") {
      console.log(HELP_TEXT);
      return;
    }

    if (command === "status") {
      printStatus();
      return;
    }

    if (command === "test-url") {
      testUrl(subcommand);
      return;
    }

    if (command === "mods" && subcommand === "list") {
      listMods();
      return;
    }

    if (command === "mods" && subcommand === "add") {
      addMod(rest[0], rest.slice(1));
      return;
    }

    if (command === "mods" && subcommand === "remove") {
      removeMod(rest[0]);
      return;
    }

    if (command === "strikes" && subcommand === "list") {
      listStrikes(rest[0]);
      return;
    }

    if (command === "strikes" && subcommand === "reset") {
      resetUserStrikes(rest[0], rest[1]);
      return;
    }

    if (command === "strikes" && subcommand === "reset-all") {
      resetEveryoneStrikes(rest[0]);
      return;
    }

    if (command === "bans" && subcommand === "list") {
      listBans(rest[0]);
      return;
    }

    if (command === "bans" && subcommand === "reset") {
      resetBan(rest[0], rest[1]);
      return;
    }

    if (command === "bans" && subcommand === "reset-all") {
      resetAllBans(rest[0]);
      return;
    }

    if (command === "mutes" && subcommand === "list") {
      listMutes(rest[0]);
      return;
    }

    if (command === "mutes" && subcommand === "reset") {
      resetMute(rest[0], rest[1]);
      return;
    }

    if (command === "mutes" && subcommand === "reset-all") {
      resetAllMutes(rest[0]);
      return;
    }

    if (command === "audit") {
      showAudit(subcommand);
      return;
    }

    fail(`unknown command: ${[command, subcommand].filter(Boolean).join(" ")}`);
  } finally {
    closeDb();
  }
};

main();
