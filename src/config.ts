import "dotenv/config";

const normaliseEnvValue = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();

  if (trimmed.length >= 2) {
    const firstChar = trimmed[0];
    const lastChar = trimmed[trimmed.length - 1];

    if (
      (firstChar === "\"" && lastChar === "\"") ||
      (firstChar === "'" && lastChar === "'")
    ) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
};

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  const normalisedValue = normaliseEnvValue(value);

  if (normalisedValue === undefined) {
    return fallback;
  }

  const normalised = normalisedValue.toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalised)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalised)) {
    return false;
  }

  return fallback;
};

const parseList = (value: string | undefined): string[] => {
  const normalisedValue = normaliseEnvValue(value);

  if (!normalisedValue) {
    return [];
  }

  return normalisedValue
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const normalisedValue = normaliseEnvValue(value);
  if (!normalisedValue) {
    return fallback;
  }

  const parsed = Number(normalisedValue);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
};

export type AnnouncementGroupMentionConfig = {
  label: string;
  jid: string;
};

const parseAnnouncementGroupMentions = (value: string | undefined): AnnouncementGroupMentionConfig[] => {
  const normalisedValue = normaliseEnvValue(value);
  if (!normalisedValue) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(normalisedValue);
  } catch {
    throw new Error("ANNOUNCEMENTS_GROUP_MENTIONS_JSON must be valid JSON");
  }

  if (!Array.isArray(parsed)) {
    throw new Error("ANNOUNCEMENTS_GROUP_MENTIONS_JSON must be a JSON array");
  }

  return parsed.map((entry, index) => {
    if (
      typeof entry !== "object" ||
      entry === null ||
      typeof (entry as AnnouncementGroupMentionConfig).label !== "string" ||
      typeof (entry as AnnouncementGroupMentionConfig).jid !== "string"
    ) {
      throw new Error(`ANNOUNCEMENTS_GROUP_MENTIONS_JSON entry ${index + 1} must have label and jid strings`);
    }

    const label = (entry as AnnouncementGroupMentionConfig).label.trim();
    const jid = (entry as AnnouncementGroupMentionConfig).jid.trim();
    if (!label || label.startsWith("@")) {
      throw new Error(`ANNOUNCEMENTS_GROUP_MENTIONS_JSON entry ${index + 1} has an invalid label`);
    }

    if (!jid.endsWith("@g.us")) {
      throw new Error(`ANNOUNCEMENTS_GROUP_MENTIONS_JSON entry ${index + 1} has an invalid group jid`);
    }

    return { label, jid };
  });
};

const parseLocalDate = (value: string | undefined): string => {
  const normalisedValue = normaliseEnvValue(value);
  if (!normalisedValue) {
    return "";
  }

  if (!/^\d{4}-\d{2}-\d{2}$/u.test(normalisedValue)) {
    throw new Error("ANNOUNCEMENTS_START_DATE must use YYYY-MM-DD");
  }

  return normalisedValue;
};

const parseLocalTime = (value: string | undefined, fallback: string): string => {
  const normalisedValue = normaliseEnvValue(value) || fallback;
  if (!/^([01]\d|2[0-3]):[0-5]\d$/u.test(normalisedValue)) {
    throw new Error("ANNOUNCEMENTS_TIME must use HH:mm");
  }

  return normalisedValue;
};

const DEFAULT_TICKET_SPOTLIGHT_TARGET_JIDS = [
  "120363417253211015@g.us",
  "120363417797746871@g.us",
  "120363401608823361@g.us",
].join(",");

const spamFloodWarnMessageLimit = parsePositiveInteger(process.env.SPAM_FLOOD_WARN_MESSAGE_LIMIT, 20);

export const NEVER_SPOTLIGHT_GROUP_JIDS = [
  "120363399525661721@g.us",
  "120363418642438451@g.us",
] as const;

const DEFAULT_ANNOUNCEMENTS_TARGET_GROUP_JID = "120363418642438451@g.us";

const loadedConfig = {
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedGroupJids: parseList(process.env.ALLOWED_GROUP_JIDS),
  ownerJids: parseList(process.env.OWNER_JIDS),
  muteOnStrike3: parseBoolean(process.env.MUTE_ON_STRIKE_3, true),
  spamDuplicateMinLength: parsePositiveInteger(process.env.SPAM_DUPLICATE_MIN_LENGTH, 20),
  spamFloodWarnMessageLimit,
  spamFloodDeleteMessageLimit: Math.max(
    parsePositiveInteger(process.env.SPAM_FLOOD_DELETE_MESSAGE_LIMIT, 25),
    spamFloodWarnMessageLimit + 1,
  ),
  defaultPhoneRegion: normaliseEnvValue(process.env.DEFAULT_PHONE_REGION)?.toUpperCase() || null,
  botName: normaliseEnvValue(process.env.BOT_NAME) || "Fete Bot",
  groupCallGuardEnabled: parseBoolean(process.env.GROUP_CALL_GUARD_ENABLED, true),
  groupCallGuardGroupJids: parseList(process.env.GROUP_CALL_GUARD_GROUP_JIDS),
  groupCallGuardWarningText:
    normaliseEnvValue(process.env.GROUP_CALL_GUARD_WARNING_TEXT) ||
    "Hey {mention} - calls aren't allowed in this group. Don't do that again. 🙏🏾",
  groupCallGuardRemoveOn: parsePositiveInteger(process.env.GROUP_CALL_GUARD_REMOVE_ON, 2),
  groupCallGuardWindowHours: parsePositiveInteger(process.env.GROUP_CALL_GUARD_WINDOW_HOURS, 24),
  groupCallGuardWarningCooldownSeconds: parsePositiveInteger(process.env.GROUP_CALL_GUARD_WARNING_COOLDOWN_SECONDS, 30),
  groupCallGuardRecentActivityTtlMinutes: parsePositiveInteger(
    process.env.GROUP_CALL_GUARD_RECENT_ACTIVITY_TTL_MINUTES,
    10,
  ),
  adminMentionCooldownMinutes: parsePositiveInteger(process.env.ADMIN_MENTION_COOLDOWN_MINUTES, 3),
  ticketMarketplaceManagement: parseBoolean(process.env.TICKET_MARKETPLACE_MANAGEMENT, true),
  ticketMarketplaceGroupJids: parseList(process.env.TICKET_MARKETPLACE_GROUP_JIDS || "120363418331899807@g.us"),
  ticketMarketplaceGroupName: normaliseEnvValue(process.env.TICKET_MARKETPLACE_GROUP_NAME) || "FDLM Ticket Marketplace",
  ticketMarketplaceReplyCooldownMinutes: parsePositiveInteger(process.env.TICKET_MARKETPLACE_REPLY_COOLDOWN_MINUTES, 30),
  ticketMarketplaceRuleReminderEnabled: parseBoolean(process.env.TICKET_MARKETPLACE_RULE_REMINDER_ENABLED, true),
  ticketMarketplaceRuleReminderTime: normaliseEnvValue(process.env.TICKET_MARKETPLACE_RULE_REMINDER_TIME) || "10:00",
  ticketMarketplaceRuleReminderTimezone:
    normaliseEnvValue(process.env.TICKET_MARKETPLACE_RULE_REMINDER_TIMEZONE) || "Europe/London",
  ticketMarketplaceRuleReminderText: normaliseEnvValue(process.env.TICKET_MARKETPLACE_RULE_REMINDER_TEXT) || "",
  ticketMarketplaceRuleReminderMinActivityMessages: parsePositiveInteger(
    process.env.TICKET_MARKETPLACE_RULE_REMINDER_MIN_ACTIVITY_MESSAGES,
    3,
  ),
  ticketSpotlightEnabled: parseBoolean(process.env.TICKET_SPOTLIGHT_ENABLED, true),
  ticketSpotlightSellingEnabled: parseBoolean(process.env.TICKET_SPOTLIGHT_SELLING_ENABLED, true),
  ticketSpotlightBuyingEnabled: parseBoolean(process.env.TICKET_SPOTLIGHT_BUYING_ENABLED, false),
  ticketSpotlightTargetJids: parseList(process.env.TICKET_SPOTLIGHT_TARGET_JIDS || DEFAULT_TICKET_SPOTLIGHT_TARGET_JIDS),
  ticketSpotlightDelayMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_DELAY_MINUTES, 20),
  ticketSpotlightSellingDelayMinutes: parsePositiveInteger(
    process.env.TICKET_SPOTLIGHT_SELLING_DELAY_MINUTES,
    parsePositiveInteger(process.env.TICKET_SPOTLIGHT_DELAY_MINUTES, 20),
  ),
  ticketSpotlightBuyingDelayMinutes: parsePositiveInteger(
    process.env.TICKET_SPOTLIGHT_BUYING_DELAY_MINUTES,
    parsePositiveInteger(process.env.TICKET_SPOTLIGHT_DELAY_MINUTES, 30),
  ),
  ticketSpotlightUserCooldownHours: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_USER_COOLDOWN_HOURS, 24),
  ticketSpotlightGroupCooldownMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_GROUP_COOLDOWN_MINUTES, 60),
  ticketSpotlightBuyingMaxPerDay: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_BUYING_MAX_PER_DAY, 2),
  ticketSpotlightSellingMaxPerDay: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_SELLING_MAX_PER_DAY, 4),
  ticketSpotlightQuietHours: normaliseEnvValue(process.env.TICKET_SPOTLIGHT_QUIET_HOURS) || "23-8",
  ticketSpotlightTimezone: normaliseEnvValue(process.env.TICKET_SPOTLIGHT_TIMEZONE) || "Europe/London",
  ticketSpotlightMinLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_MIN_LENGTH, 15),
  ticketSpotlightBuyingMinLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_BUYING_MIN_LENGTH, 30),
  ticketSpotlightSellingMinLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_SELLING_MIN_LENGTH, 15),
  ticketSpotlightMaxLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_MAX_LENGTH, 400),
  ticketSpotlightBlocklistJids: parseList(process.env.TICKET_SPOTLIGHT_BLOCKLIST_JIDS),
  ticketSpotlightClaimStaleMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_CLAIM_STALE_MINUTES, 5),
  ticketSpotlightReactionEmoji: normaliseEnvValue(process.env.TICKET_SPOTLIGHT_REACTION_EMOJI) || "⭐",
  announcementsEnabled: parseBoolean(process.env.ANNOUNCEMENTS_ENABLED, false),
  announcementsTargetGroupJid:
    normaliseEnvValue(process.env.ANNOUNCEMENTS_TARGET_GROUP_JID) || DEFAULT_ANNOUNCEMENTS_TARGET_GROUP_JID,
  announcementsStartDate: parseLocalDate(process.env.ANNOUNCEMENTS_START_DATE),
  announcementsTime: parseLocalTime(process.env.ANNOUNCEMENTS_TIME, "10:00"),
  announcementsIntervalDays: parsePositiveInteger(process.env.ANNOUNCEMENTS_INTERVAL_DAYS, 3),
  announcementsTimezone: normaliseEnvValue(process.env.ANNOUNCEMENTS_TIMEZONE) || "Europe/London",
  announcementsGroupMentions: parseAnnouncementGroupMentions(process.env.ANNOUNCEMENTS_GROUP_MENTIONS_JSON),
  logAllowedMessages: parseBoolean(process.env.LOG_ALLOWED_MESSAGES, true),
  logMessageText: parseBoolean(process.env.LOG_MESSAGE_TEXT, false),
} as const;

export const config = Object.freeze(loadedConfig);

export type Config = typeof config;
