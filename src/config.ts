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

const loadedConfig = {
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedGroupJids: parseList(process.env.ALLOWED_GROUP_JIDS),
  ownerJids: parseList(process.env.OWNER_JIDS),
  muteOnStrike3: parseBoolean(process.env.MUTE_ON_STRIKE_3, true),
  defaultPhoneRegion: normaliseEnvValue(process.env.DEFAULT_PHONE_REGION)?.toUpperCase() || null,
  botName: normaliseEnvValue(process.env.BOT_NAME) || "Fete Bot",
  ticketMarketplaceManagement: parseBoolean(process.env.TICKET_MARKETPLACE_MANAGEMENT, true),
  ticketMarketplaceGroupJids: parseList(process.env.TICKET_MARKETPLACE_GROUP_JIDS || "120363418331899807@g.us"),
  ticketMarketplaceGroupName: normaliseEnvValue(process.env.TICKET_MARKETPLACE_GROUP_NAME) || "FDLM Ticket Marketplace",
  ticketSpotlightEnabled: parseBoolean(process.env.TICKET_SPOTLIGHT_ENABLED, true),
  ticketSpotlightBuyingEnabled: parseBoolean(process.env.TICKET_SPOTLIGHT_BUYING_ENABLED, true),
  ticketSpotlightTargetJids: parseList(process.env.TICKET_SPOTLIGHT_TARGET_JIDS),
  ticketSpotlightDelayMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_DELAY_MINUTES, 20),
  ticketSpotlightUserCooldownHours: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_USER_COOLDOWN_HOURS, 24),
  ticketSpotlightGroupCooldownMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_GROUP_COOLDOWN_MINUTES, 120),
  ticketSpotlightMaxPerDay: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_MAX_PER_DAY, 4),
  ticketSpotlightQuietHours: normaliseEnvValue(process.env.TICKET_SPOTLIGHT_QUIET_HOURS) || "23-8",
  ticketSpotlightTimezone: normaliseEnvValue(process.env.TICKET_SPOTLIGHT_TIMEZONE) || "Europe/London",
  ticketSpotlightMinLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_MIN_LENGTH, 15),
  ticketSpotlightBuyingMinLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_BUYING_MIN_LENGTH, 30),
  ticketSpotlightMaxLength: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_MAX_LENGTH, 400),
  ticketSpotlightBlocklistJids: parseList(process.env.TICKET_SPOTLIGHT_BLOCKLIST_JIDS),
  ticketSpotlightClaimStaleMinutes: parsePositiveInteger(process.env.TICKET_SPOTLIGHT_CLAIM_STALE_MINUTES, 5),
} as const;

export const config = Object.freeze(loadedConfig);

export type Config = typeof config;
