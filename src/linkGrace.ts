import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "./storagePaths.js";

const LINK_GRACE_PATH = join(DATA_DIR, "link-grace.json");

export type LinkGraceEntry = {
  userId: string;
  groupJid: string;
  expiresAt: string;
  grantedAt: string;
  grantedBy: string | null;
};

type LinkGraceState = {
  grants: Record<string, LinkGraceEntry>;
};

const defaultState = (): LinkGraceState => ({ grants: {} });

const getKey = (userId: string, groupJid: string): string => `${groupJid}::${userId}`;

const readLinkGraceState = (): LinkGraceState => {
  if (!existsSync(LINK_GRACE_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(readFileSync(LINK_GRACE_PATH, "utf8")) as Partial<LinkGraceState>;
    const grants: Record<string, LinkGraceEntry> = {};

    for (const [key, entry] of Object.entries(parsed.grants ?? {})) {
      if (
        typeof entry !== "object" ||
        entry === null ||
        typeof entry.userId !== "string" ||
        typeof entry.groupJid !== "string" ||
        typeof entry.expiresAt !== "string"
      ) {
        continue;
      }

      grants[key] = {
        userId: entry.userId,
        groupJid: entry.groupJid,
        expiresAt: entry.expiresAt,
        grantedAt: typeof entry.grantedAt === "string" ? entry.grantedAt : new Date(0).toISOString(),
        grantedBy: typeof entry.grantedBy === "string" ? entry.grantedBy : null,
      };
    }

    return { grants };
  } catch {
    return defaultState();
  }
};

const writeLinkGraceState = (state: LinkGraceState): void => {
  ensureStorageDirs();
  const tempPath = `${LINK_GRACE_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, LINK_GRACE_PATH);
};

const purgeExpired = (state: LinkGraceState, nowMs = Date.now()): LinkGraceState => {
  let changed = false;
  for (const [key, entry] of Object.entries(state.grants)) {
    if (Date.parse(entry.expiresAt) <= nowMs) {
      delete state.grants[key];
      changed = true;
    }
  }

  if (changed) {
    writeLinkGraceState(state);
  }

  return state;
};

export const grantLinkGrace = (
  userId: string,
  groupJid: string,
  durationMs: number,
  grantedBy: string | null,
): LinkGraceEntry => {
  const state = purgeExpired(readLinkGraceState());
  const now = Date.now();
  const entry: LinkGraceEntry = {
    userId,
    groupJid,
    grantedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + durationMs).toISOString(),
    grantedBy,
  };
  state.grants[getKey(userId, groupJid)] = entry;
  writeLinkGraceState(state);
  return entry;
};

export const getActiveLinkGrace = (
  userId: string,
  groupJid: string,
  nowMs = Date.now(),
): LinkGraceEntry | null => {
  const state = purgeExpired(readLinkGraceState(), nowMs);
  const entry = state.grants[getKey(userId, groupJid)];
  return entry && Date.parse(entry.expiresAt) > nowMs ? entry : null;
};

export const isLinkGraceActive = (userId: string, groupJid: string, nowMs = Date.now()): boolean =>
  getActiveLinkGrace(userId, groupJid, nowMs) !== null;
