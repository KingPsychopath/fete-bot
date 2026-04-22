import { promises as fs } from "node:fs";
import path from "node:path";
import { AUTH_DIR } from "./storagePaths.js";

const lidToPhone = new Map<string, string>();

export async function loadLidMappings(authDir = AUTH_DIR): Promise<void> {
  lidToPhone.clear();

  let entries: string[];
  try {
    entries = await fs.readdir(authDir);
  } catch {
    return;
  }

  const files = entries.filter(
    (entry) =>
      entry.startsWith("lid-mapping-") &&
      entry.endsWith(".json") &&
      !entry.endsWith("_reverse.json"),
  );

  for (const file of files) {
    const phoneUser = file.slice("lid-mapping-".length, -".json".length);

    try {
      const raw = await fs.readFile(path.join(authDir, file), "utf8");
      const parsed = JSON.parse(raw);
      const lidUser = typeof parsed === "string" ? parsed : String(parsed ?? "").trim();

      if (lidUser && phoneUser) {
        lidToPhone.set(lidUser, phoneUser);
      }
    } catch {
      // Ignore malformed or transient files so auth still works when mappings are incomplete.
    }
  }
}

function splitJid(jid: string): { user: string; server: string } | null {
  const atIndex = jid.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }

  return {
    user: jid.slice(0, atIndex),
    server: jid.slice(atIndex + 1),
  };
}

function baseUser(user: string): string {
  const colonIndex = user.indexOf(":");
  return colonIndex >= 0 ? user.slice(0, colonIndex) : user;
}

export function normalizeJid(jid: string): string {
  const parts = splitJid(jid);
  if (!parts || parts.server !== "lid") {
    return jid;
  }

  const phoneUser = lidToPhone.get(baseUser(parts.user));
  if (!phoneUser) {
    return jid;
  }

  return `${phoneUser}@s.whatsapp.net`;
}

export function expandCandidateJids(candidateJids: ReadonlyArray<string | null | undefined>): string[] {
  const expandedJids = new Set<string>();

  for (const jid of candidateJids) {
    if (!jid) {
      continue;
    }

    expandedJids.add(jid);

    const normalizedJid = normalizeJid(jid);
    if (normalizedJid !== jid) {
      expandedJids.add(normalizedJid);
    }
  }

  return Array.from(expandedJids);
}
