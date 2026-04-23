import { promises as fs } from "node:fs";
import path from "node:path";

import { AUTH_DIR } from "./storagePaths.js";

const lidToPhone = new Map<string, string>();
const phoneToLids = new Map<string, Set<string>>();

const splitJid = (jid: string): { user: string; server: string } | null => {
  const atIndex = jid.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }

  return {
    user: jid.slice(0, atIndex),
    server: jid.slice(atIndex + 1),
  };
};

const stripDeviceSuffix = (user: string): string => {
  const colonIndex = user.indexOf(":");
  return colonIndex >= 0 ? user.slice(0, colonIndex) : user;
};

const normalizeAlias = (alias: string): string => {
  const trimmed = alias.trim().toLowerCase();
  const parts = splitJid(trimmed);
  if (!parts) {
    return trimmed;
  }

  if (parts.server === "s.whatsapp.net" || parts.server === "lid") {
    return `${stripDeviceSuffix(parts.user)}@${parts.server}`;
  }

  return `${parts.user}@${parts.server}`;
};

export async function loadLidMappings(authDir = AUTH_DIR): Promise<void> {
  lidToPhone.clear();
  phoneToLids.clear();

  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.startsWith("lid-mapping-") || !entry.endsWith(".json") || entry.endsWith("_reverse.json")) {
      continue;
    }

    const phoneUser = entry.slice("lid-mapping-".length, -".json".length).trim();
    if (!phoneUser) {
      continue;
    }

    try {
      const raw = await fs.readFile(path.join(authDir, entry), "utf8");
      const parsed = JSON.parse(raw);
      const lidUser = typeof parsed === "string" ? parsed.trim() : String(parsed ?? "").trim();
      if (!lidUser) {
        continue;
      }

      const phoneAlias = normalizeAlias(`${phoneUser}@s.whatsapp.net`);
      const lidAlias = normalizeAlias(`${lidUser}@lid`);
      lidToPhone.set(lidAlias, phoneAlias);
      const lids = phoneToLids.get(phoneAlias) ?? new Set<string>();
      lids.add(lidAlias);
      phoneToLids.set(phoneAlias, lids);
    } catch {
      // Ignore malformed or transient mapping files.
    }
  }
}

export const recordLidMapping = (phoneAlias: string, lidAlias: string): void => {
  const normalizedPhoneAlias = normalizeAlias(phoneAlias);
  const normalizedLidAlias = normalizeAlias(lidAlias);

  lidToPhone.set(normalizedLidAlias, normalizedPhoneAlias);
  const lids = phoneToLids.get(normalizedPhoneAlias) ?? new Set<string>();
  lids.add(normalizedLidAlias);
  phoneToLids.set(normalizedPhoneAlias, lids);
};

export const getMappedPhoneAlias = (lidAlias: string): string | null => lidToPhone.get(normalizeAlias(lidAlias)) ?? null;

export const getMappedLidAliases = (phoneAlias: string): string[] =>
  Array.from(phoneToLids.get(normalizeAlias(phoneAlias)) ?? []);

export const expandKnownAliases = (aliases: ReadonlyArray<string | null | undefined>): string[] => {
  const expandedAliases = new Set<string>();

  for (const alias of aliases) {
    if (!alias) {
      continue;
    }

    const normalizedAlias = normalizeAlias(alias);
    expandedAliases.add(normalizedAlias);

    const mappedPhoneAlias = getMappedPhoneAlias(normalizedAlias);
    if (mappedPhoneAlias) {
      expandedAliases.add(mappedPhoneAlias);
    }

    for (const mappedLidAlias of getMappedLidAliases(normalizedAlias)) {
      expandedAliases.add(mappedLidAlias);
    }
  }

  return Array.from(expandedAliases);
};
