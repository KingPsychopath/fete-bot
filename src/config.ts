import "dotenv/config";

const parseBoolean = (value: string | undefined, fallback: boolean): boolean => {
  if (value === undefined) {
    return fallback;
  }

  const normalised = value.trim().toLowerCase();

  if (["1", "true", "yes", "on"].includes(normalised)) {
    return true;
  }

  if (["0", "false", "no", "off"].includes(normalised)) {
    return false;
  }

  return fallback;
};

const parseList = (value: string | undefined): string[] => {
  if (!value) {
    return [];
  }

  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
};

const loadedConfig = {
  dryRun: parseBoolean(process.env.DRY_RUN, true),
  allowedGroupJids: parseList(process.env.ALLOWED_GROUP_JIDS),
  ownerJids: parseList(process.env.OWNER_JIDS),
  muteOnStrike3: parseBoolean(process.env.MUTE_ON_STRIKE_3, true),
  botName: process.env.BOT_NAME?.trim() || "Fete Bot",
} as const;

export const config = Object.freeze(loadedConfig);

export type Config = typeof config;
