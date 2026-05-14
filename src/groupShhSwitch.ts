import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "./storagePaths.js";

const GROUP_SHH_SWITCH_PATH = join(DATA_DIR, "group-shh-switch.json");

export type GroupShhEntry = {
  groupJid: string;
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

type GroupShhState = {
  groups: Record<string, GroupShhEntry>;
};

const defaultState = (): GroupShhState => ({ groups: {} });

const readGroupShhState = (): GroupShhState => {
  if (!existsSync(GROUP_SHH_SWITCH_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(readFileSync(GROUP_SHH_SWITCH_PATH, "utf8")) as Partial<GroupShhState>;
    const groups: Record<string, GroupShhEntry> = {};

    for (const [groupJid, entry] of Object.entries(parsed.groups ?? {})) {
      if (typeof entry !== "object" || entry === null) {
        continue;
      }

      groups[groupJid] = {
        groupJid,
        enabled: entry.enabled === true,
        updatedAt: typeof entry.updatedAt === "string" ? entry.updatedAt : new Date(0).toISOString(),
        updatedBy: typeof entry.updatedBy === "string" ? entry.updatedBy : null,
      };
    }

    return { groups };
  } catch {
    return defaultState();
  }
};

const writeGroupShhState = (state: GroupShhState): void => {
  ensureStorageDirs();
  const tempPath = `${GROUP_SHH_SWITCH_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, GROUP_SHH_SWITCH_PATH);
};

export const getGroupShhEntry = (groupJid: string): GroupShhEntry => {
  const entry = readGroupShhState().groups[groupJid];
  return entry ?? {
    groupJid,
    enabled: false,
    updatedAt: new Date(0).toISOString(),
    updatedBy: null,
  };
};

export const isGroupShhEnabled = (groupJid: string): boolean => getGroupShhEntry(groupJid).enabled;

export const setGroupShhEnabled = (
  groupJid: string,
  enabled: boolean,
  updatedBy: string | null,
): GroupShhEntry => {
  const state = readGroupShhState();
  const entry: GroupShhEntry = {
    groupJid,
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  state.groups[groupJid] = entry;
  writeGroupShhState(state);
  return entry;
};

export const listEnabledGroupShhEntries = (): GroupShhEntry[] =>
  Object.values(readGroupShhState().groups).filter((entry) => entry.enabled);
