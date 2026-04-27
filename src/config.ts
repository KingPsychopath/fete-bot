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
    "Hey {mention} - calls aren't allowed in this group, so I ended that call. Don't do that again. 🙏🏾",
  ticketMarketplaceManagement: parseBoolean(process.env.TICKET_MARKETPLACE_MANAGEMENT, true),
  ticketMarketplaceGroupJids: parseList(process.env.TICKET_MARKETPLACE_GROUP_JIDS || "120363418331899807@g.us"),
  ticketMarketplaceGroupName: normaliseEnvValue(process.env.TICKET_MARKETPLACE_GROUP_NAME) || "FDLM Ticket Marketplace",
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
} as const;

export const config = Object.freeze(loadedConfig);

export type Config = typeof config;
