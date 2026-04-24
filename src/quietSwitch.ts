import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "./storagePaths.js";

const QUIET_SWITCH_PATH = join(DATA_DIR, "quiet-switch.json");
const bypassContents = new WeakSet<object>();

type QuietSwitchState = {
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

const defaultState = (): QuietSwitchState => ({
  enabled: false,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
});

const readQuietSwitchState = (): QuietSwitchState => {
  if (!existsSync(QUIET_SWITCH_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(readFileSync(QUIET_SWITCH_PATH, "utf8")) as Partial<QuietSwitchState>;
    return {
      enabled: parsed.enabled === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaultState().updatedAt,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return defaultState();
  }
};

export const getQuietSwitchState = (): QuietSwitchState => readQuietSwitchState();

export const isQuietSwitchEnabled = (): boolean => readQuietSwitchState().enabled;

export const setQuietSwitchEnabled = (enabled: boolean, updatedBy: string | null): QuietSwitchState => {
  ensureStorageDirs();
  const state: QuietSwitchState = {
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const tempPath = `${QUIET_SWITCH_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, QUIET_SWITCH_PATH);
  return state;
};

export const allowQuietSwitchSend = (content: object): void => {
  bypassContents.add(content);
};

export const consumeQuietSwitchSendBypass = (content: unknown): boolean => {
  if (typeof content !== "object" || content === null || !bypassContents.has(content)) {
    return false;
  }

  bypassContents.delete(content);
  return true;
};
