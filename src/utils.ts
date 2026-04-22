import type { WAMessage } from "@whiskeysockets/baileys";
import type { GroupMetadata, GroupParticipant } from "@whiskeysockets/baileys";

import type { Config } from "./config.js";
import { isModerator } from "./db.js";

export function parseToJid(input: string): string | null {
  const trimmed = input.trim();

  if (trimmed.endsWith("@s.whatsapp.net")) {
    return /^\d{7,15}@s\.whatsapp\.net$/.test(trimmed) ? trimmed : null;
  }

  if (trimmed.endsWith("@lid") || trimmed.endsWith("@g.us")) {
    return null;
  }

  if (!trimmed) {
    return null;
  }

  let working = trimmed.replace(/[\s().-]/g, "");

  if (working.startsWith("00")) {
    working = `+${working.slice(2)}`;
  }

  if (working.startsWith("+")) {
    working = working.slice(1);
  }

  // NOTE: Local format numbers (starting with 0) are assumed to be UK (+44).
  // For non-UK numbers, owners and moderators should always use international format:
  // +33 6 12 34 56 78 (France), +1 212 555 0123 (US), +234 701 234 5678 (Nigeria) etc.
  // This is documented in README and !help output.
  if (working.startsWith("0")) {
    console.warn(
      "Assuming UK number for local format 0XXXX — use international format for non-UK numbers",
    );
    working = `44${working.slice(1)}`;
  }

  if (!/^\d{7,15}$/.test(working)) {
    return null;
  }

  const jid = `${working}@s.whatsapp.net`;
  return /^\d{7,15}@s\.whatsapp\.net$/.test(jid) ? jid : null;
}

export function extractAllIdentifiers(msg: WAMessage): {
  senderJid: string;
  phoneNumber: string | null;
  lidJid: string | null;
} {
  const senderJid = msg.key.participant ?? msg.key.remoteJid ?? "";
  const participantPn =
    (msg.key as { participantPn?: string | null }).participantPn ??
    (msg as { key?: { participantPn?: string | null } }).key?.participantPn ??
    null;
  const phoneNumberJid = participantPn ? parseToJid(participantPn) : null;
  const phoneNumber =
    phoneNumberJid?.replace(/@s\.whatsapp\.net$/i, "") ??
    (senderJid.endsWith("@s.whatsapp.net")
      ? senderJid.replace(/@s\.whatsapp\.net$/i, "")
      : null);
  const lidJid = senderJid.endsWith("@lid") ? senderJid : null;

  return {
    senderJid,
    phoneNumber,
    lidJid,
  };
}

export function formatJidForDisplay(jid: string): string {
  if (jid.endsWith("@s.whatsapp.net")) {
    const digits = jid.replace(/@s\.whatsapp\.net$/i, "");
    return `+${digits}`;
  }

  if (jid.endsWith("@lid")) {
    return "internal user (lid)";
  }

  if (jid.endsWith("@g.us")) {
    return "group";
  }

  return jid;
}

export function parseDuration(param?: string): Date | null {
  if (!param) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  const normalised = param.trim().toLowerCase();
  if (normalised === "permanent" || normalised === "perm") {
    return null;
  }

  const match = normalised.match(/^(\d+)([mhd])$/);
  if (!match) {
    return new Date(Date.now() + 24 * 60 * 60 * 1000);
  }

  const value = Number(match[1]);
  const unit = match[2];
  const multipliers = {
    m: 60 * 1000,
    h: 60 * 60 * 1000,
    d: 24 * 60 * 60 * 1000,
  } as const;

  return new Date(Date.now() + value * multipliers[unit as keyof typeof multipliers]);
}

export function isAuthorised(jid: string, config: Config): boolean {
  return config.ownerJids.includes(jid) || isModerator(jid);
}

export function hasAdminPrivileges(
  participant: Pick<GroupParticipant, "admin" | "isAdmin" | "isSuperAdmin"> | null | undefined,
): boolean {
  return Boolean(participant?.admin || participant?.isAdmin || participant?.isSuperAdmin);
}

export function isGroupAdmin(
  jid: string,
  groupJid: string,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): boolean {
  const groupMetadata = groupMetadataByJid.get(groupJid);
  if (!groupMetadata) {
    return false;
  }

  return groupMetadata.participants.some(
    (participant) => participant.id === jid && hasAdminPrivileges(participant),
  );
}

export function isProtectedGroupMember(
  candidateJids: readonly string[],
  groupJid: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
): boolean {
  return candidateJids.some(
    (candidateJid) =>
      isAuthorised(candidateJid, config) || isGroupAdmin(candidateJid, groupJid, groupMetadataByJid),
  );
}

// UK numbers
// parseToJid("07911123456")              → "447911123456@s.whatsapp.net"
// parseToJid("+447911123456")            → "447911123456@s.whatsapp.net"
// parseToJid("+44 7911 123 456")         → "447911123456@s.whatsapp.net"
// parseToJid("+44(0)7911123456")         → "447911123456@s.whatsapp.net"
// parseToJid("00447911123456")           → "447911123456@s.whatsapp.net"

// International numbers
// parseToJid("+1 212 555 0123")          → "12125550123@s.whatsapp.net"
// parseToJid("+33 6 12 34 56 78")        → "33612345678@s.whatsapp.net"
// parseToJid("+234 701 234 5678")        → "2347012345678@s.whatsapp.net"
// parseToJid("+81 90 1234 5678")         → "819012345678@s.whatsapp.net"
// parseToJid("+55 11 91234 5678")        → "5511912345678@s.whatsapp.net"

// Passthrough
// parseToJid("447911123456@s.whatsapp.net") → "447911123456@s.whatsapp.net"

// Invalid
// parseToJid("447911123456@lid")         → null
// parseToJid("120363XXX@g.us")           → null
// parseToJid("not a number")             → null
// parseToJid("123")                      → null
// parseToJid("")                         → null

// Ambiguous (UK assumed, warn in console)
// parseToJid("07911123456")              → "447911123456@s.whatsapp.net" + console warn
