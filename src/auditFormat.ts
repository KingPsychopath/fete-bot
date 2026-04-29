import type { AuditEntry } from "./db.js";

const canonicalAuditCommand = (command: string): string => command === "!kick" ? "!remove" : command;

const COMMANDS_WITH_DEFAULT_ALL_MANAGED_GROUP_SCOPE = new Set([
  "!ban",
  "!unban",
  "!mute",
  "!unmute",
  "!remove",
  "!strike",
  "!pardon",
  "!resetstrikes",
]);

export const formatAuditGroupLabel = (entry: Pick<AuditEntry, "command" | "groupJid" | "result">): string => {
  if (entry.groupJid) {
    return entry.groupJid;
  }

  if (
    entry.result === "success" &&
    COMMANDS_WITH_DEFAULT_ALL_MANAGED_GROUP_SCOPE.has(canonicalAuditCommand(entry.command))
  ) {
    return "all managed groups";
  }

  return "n/a";
};
