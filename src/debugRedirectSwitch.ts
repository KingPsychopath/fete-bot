import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "./storagePaths.js";

const DEBUG_REDIRECT_SWITCH_PATH = join(DATA_DIR, "debug-redirect-switch.json");
const DEFAULT_DEBUG_REDIRECT_JID = "120363424893007022@g.us";

type DebugRedirectSwitchState = {
  enabled: boolean;
  targetJid: string | null;
  updatedAt: string;
  updatedBy: string | null;
};

const normaliseEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  const normalised = normaliseEnvValue(value)?.toLowerCase();
  if (!normalised) {
    return fallback;
  }
  if (["1", "true", "yes", "on"].includes(normalised)) {
    return true;
  }
  if (["0", "false", "no", "off"].includes(normalised)) {
    return false;
  }
  return fallback;
};

const defaultState = (): DebugRedirectSwitchState => ({
  enabled: parseBoolean(process.env.DEBUG_REDIRECT_ENABLED, false),
  targetJid: normaliseEnvValue(process.env.DEBUG_REDIRECT_JID) ?? DEFAULT_DEBUG_REDIRECT_JID,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
});

const readDebugRedirectSwitchState = (): DebugRedirectSwitchState => {
  const fallback = defaultState();
  if (!existsSync(DEBUG_REDIRECT_SWITCH_PATH)) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(readFileSync(DEBUG_REDIRECT_SWITCH_PATH, "utf8")) as Partial<DebugRedirectSwitchState>;
    return {
      enabled: parsed.enabled === true,
      targetJid: typeof parsed.targetJid === "string" && parsed.targetJid.trim() ? parsed.targetJid.trim() : fallback.targetJid,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : fallback.updatedAt,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return fallback;
  }
};

export const getDebugRedirectSwitchState = (): DebugRedirectSwitchState => readDebugRedirectSwitchState();

export const setDebugRedirectSwitchState = (
  enabled: boolean,
  targetJid: string | null,
  updatedBy: string | null,
): DebugRedirectSwitchState => {
  ensureStorageDirs();
  const previous = readDebugRedirectSwitchState();
  const state: DebugRedirectSwitchState = {
    enabled,
    targetJid: targetJid?.trim() || previous.targetJid,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const tempPath = `${DEBUG_REDIRECT_SWITCH_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, DEBUG_REDIRECT_SWITCH_PATH);
  return state;
};

export const formatDebugRedirectSwitchStatus = (): string => {
  const state = getDebugRedirectSwitchState();
  const status = state.enabled ? "ON - outbound messages are rerouted" : "OFF - outbound messages go to their real chats";
  return `Debug redirect: ${status}
Target: ${state.targetJid ?? "not set"}
Updated: ${state.updatedAt}
Updated by: ${state.updatedBy ?? "unknown"}`;
};

export const buildDebugRedirectText = (originalJid: string, content: unknown): string => {
  const keys = typeof content === "object" && content !== null ? Object.keys(content) : [];
  const text =
    typeof content === "object" &&
    content !== null &&
    "text" in content &&
    typeof (content as { text?: unknown }).text === "string"
      ? (content as { text: string }).text
      : `[non-text WhatsApp payload: ${keys.length > 0 ? keys.join(", ") : "unknown"}]`;

  return `DEBUG REDIRECT
Original target: ${originalJid}

${text}`;
};

export const buildDebugParticipantUpdateText = (
  groupJid: string,
  participants: readonly string[],
  action: string,
): string => `DEBUG REDIRECT
Original target: ${groupJid}

[group participant update: ${action}]
${participants.join("\n")}`;
