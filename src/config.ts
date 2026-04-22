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

const loadedConfig = {
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedGroupJids: parseList(process.env.ALLOWED_GROUP_JIDS),
  ownerJids: parseList(process.env.OWNER_JIDS),
  muteOnStrike3: parseBoolean(process.env.MUTE_ON_STRIKE_3, true),
  botName: normaliseEnvValue(process.env.BOT_NAME) || "Fete Bot",
} as const;

export const config = Object.freeze(loadedConfig);

export type Config = typeof config;
