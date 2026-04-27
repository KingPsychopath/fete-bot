import type { WASocket } from "@whiskeysockets/baileys";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { Config } from "../../config.js";
import { warn } from "../../logger.js";
import { DATA_DIR, ensureStorageDirs } from "../../storagePaths.js";

const RULE_REMINDER_STATE_PATH = join(DATA_DIR, "ticket-marketplace-rule-reminder.json");
const POLL_INTERVAL_MS = 60_000;
const DEFAULT_REMINDER_TIME = "10:00";
const DEFAULT_TIME_ZONE = "Europe/London";

type RuleReminderState = {
  sentLocalDateByGroupJid: Record<string, string>;
  lastSentAtByGroupJid: Record<string, string>;
  lastActivityAtByGroupJid: Record<string, string>;
  activityCountSinceLastReminderByGroupJid: Record<string, number>;
};

type RuleReminderSocket = Pick<WASocket, "groupMetadata" | "sendMessage">;

let reminderTimer: ReturnType<typeof setInterval> | null = null;
let reminderRunning = false;

const defaultState = (): RuleReminderState => ({
  sentLocalDateByGroupJid: {},
  lastSentAtByGroupJid: {},
  lastActivityAtByGroupJid: {},
  activityCountSinceLastReminderByGroupJid: {},
});

const readStringRecord = (value: unknown): Record<string, string> =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, string] => typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      )
    : {};

const readNumberRecord = (value: unknown): Record<string, number> =>
  value && typeof value === "object"
    ? Object.fromEntries(
        Object.entries(value).filter(
          (entry): entry is [string, number] => typeof entry[0] === "string" && typeof entry[1] === "number",
        ),
      )
    : {};

const readState = (): RuleReminderState => {
  if (!existsSync(RULE_REMINDER_STATE_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(readFileSync(RULE_REMINDER_STATE_PATH, "utf8")) as Partial<RuleReminderState>;
    return {
      sentLocalDateByGroupJid: readStringRecord(parsed.sentLocalDateByGroupJid),
      lastSentAtByGroupJid: readStringRecord(parsed.lastSentAtByGroupJid),
      lastActivityAtByGroupJid: readStringRecord(parsed.lastActivityAtByGroupJid),
      activityCountSinceLastReminderByGroupJid: readNumberRecord(parsed.activityCountSinceLastReminderByGroupJid),
    };
  } catch {
    return defaultState();
  }
};

const writeState = (state: RuleReminderState): void => {
  ensureStorageDirs();
  const tempPath = `${RULE_REMINDER_STATE_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, RULE_REMINDER_STATE_PATH);
};

const getDateTimeParts = (date: Date, timeZone: string): Record<string, string> => {
  const formatterOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  } as const;

  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", formatterOptions)
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  } catch {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { ...formatterOptions, timeZone: DEFAULT_TIME_ZONE })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  }
};

const parseReminderTime = (value: string): { hour: number; minute: number } => {
  const match = value.trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/u);
  if (!match) {
    return parseReminderTime(DEFAULT_REMINDER_TIME);
  }

  return {
    hour: Number(match[1]),
    minute: Number(match[2]),
  };
};

const getLocalDateKey = (date: Date, timeZone: string): string => {
  const parts = getDateTimeParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

const hasReachedReminderTime = (date: Date, timeZone: string, reminderTime: string): boolean => {
  const parts = getDateTimeParts(date, timeZone);
  const currentMinutes = Number(parts.hour) * 60 + Number(parts.minute);
  const configured = parseReminderTime(reminderTime);
  return currentMinutes >= configured.hour * 60 + configured.minute;
};

export const buildTicketMarketplaceRuleReminderMessage = (
  config: Config,
  groupDescription?: string | null,
): string => {
  const configuredText = config.ticketMarketplaceRuleReminderText.trim();
  if (configuredText) {
    return configuredText;
  }

  const reminder = `📌 Daily reminder: please make sure you follow the rules of ${config.ticketMarketplaceGroupName}. You can refer to them by reading the pinned message and group description in this chat.`;
  const descriptionText = groupDescription?.trim();

  return descriptionText ? `${reminder}\n\n${descriptionText}` : reminder;
};

const getGroupDescription = async (sock: RuleReminderSocket, groupJid: string): Promise<string | null> => {
  try {
    return (await sock.groupMetadata(groupJid)).desc ?? null;
  } catch (metadataError) {
    warn("Failed to fetch ticket marketplace group description for reminder", { groupJid, error: metadataError });
    return null;
  }
};

export const recordTicketMarketplaceRuleReminderActivity = (groupJid: string, now = new Date()): void => {
  const state = readState();
  state.lastActivityAtByGroupJid[groupJid] = now.toISOString();
  state.activityCountSinceLastReminderByGroupJid[groupJid] =
    (state.activityCountSinceLastReminderByGroupJid[groupJid] ?? 0) + 1;
  writeState(state);
};

const hasEnoughActivitySinceLastReminder = (state: RuleReminderState, config: Config, groupJid: string): boolean => {
  const lastSentAt = state.lastSentAtByGroupJid[groupJid];
  if (!lastSentAt) {
    return true;
  }

  return (
    (state.activityCountSinceLastReminderByGroupJid[groupJid] ?? 0) >=
    config.ticketMarketplaceRuleReminderMinActivityMessages
  );
};

export const runTicketMarketplaceRuleReminderTick = async (
  sock: RuleReminderSocket,
  config: Config,
  now = new Date(),
): Promise<void> => {
  if (
    !config.ticketMarketplaceRuleReminderEnabled ||
    !config.ticketMarketplaceManagement ||
    config.ticketMarketplaceGroupJids.length === 0 ||
    reminderRunning ||
    !hasReachedReminderTime(now, config.ticketMarketplaceRuleReminderTimezone, config.ticketMarketplaceRuleReminderTime)
  ) {
    return;
  }

  reminderRunning = true;
  try {
    const localDateKey = getLocalDateKey(now, config.ticketMarketplaceRuleReminderTimezone);
    const state = readState();

    for (const groupJid of config.ticketMarketplaceGroupJids) {
      if (state.sentLocalDateByGroupJid[groupJid] === localDateKey) {
        continue;
      }

      if (!hasEnoughActivitySinceLastReminder(state, config, groupJid)) {
        continue;
      }

      try {
        const groupDescription = await getGroupDescription(sock, groupJid);
        const message = buildTicketMarketplaceRuleReminderMessage(config, groupDescription);
        await sock.sendMessage(groupJid, { text: message });
        state.sentLocalDateByGroupJid[groupJid] = localDateKey;
        state.lastSentAtByGroupJid[groupJid] = now.toISOString();
        state.activityCountSinceLastReminderByGroupJid[groupJid] = 0;
        writeState(state);
      } catch (sendError) {
        warn("Failed to send ticket marketplace rule reminder", { groupJid, error: sendError });
      }
    }
  } finally {
    reminderRunning = false;
  }
};

export const startTicketMarketplaceRuleReminderScheduler = (
  sock: RuleReminderSocket,
  config: Config,
): void => {
  if (!config.ticketMarketplaceRuleReminderEnabled || reminderTimer) {
    return;
  }

  reminderTimer = setInterval(() => {
    void runTicketMarketplaceRuleReminderTick(sock, config);
  }, POLL_INTERVAL_MS);
  reminderTimer.unref();

  void runTicketMarketplaceRuleReminderTick(sock, config);
};

export const stopTicketMarketplaceRuleReminderScheduler = (): void => {
  if (reminderTimer) {
    clearInterval(reminderTimer);
    reminderTimer = null;
  }
};
