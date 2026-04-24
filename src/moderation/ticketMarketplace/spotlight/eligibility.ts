import type { Config } from "../../../config.js";
import { extractUrls } from "../../../linkChecker.js";
import type { TicketMarketplaceIntent } from "../classifier.js";

export type SpotlightEligibilityInput = {
  groupJid: string;
  senderJid: string;
  text: string;
  intent: TicketMarketplaceIntent;
  hasPrice: boolean;
  isReply: boolean;
  isCommand: boolean;
  fromMe: boolean;
};

export type SpotlightEligibilityResult =
  | { eligible: true }
  | { eligible: false; reason: string };

const HOUR_RANGE_REGEX = /^\s*(\d{1,2})\s*-\s*(\d{1,2})\s*$/u;
const PHONE_NUMBER_REGEX =
  /(?:\b0\s*7(?:[\s.-]*\d){9}\b|\b44(?:[\s.-]*\d){10}\b|\+\s*44(?:[\s.-]*\d){10}\b|\+\s*\d{2,3}(?:[\s.-]*\d){8,12}\b)/iu;

const normaliseJid = (jid: string): string => jid.trim().toLowerCase();

export const hasUrlLikeText = (text: string): boolean => extractUrls(text).length > 0;
export const hasPhoneLikeText = (text: string): boolean => PHONE_NUMBER_REGEX.test(text);

export const isQuietHour = (date: Date, quietHours: string, timeZone: string): boolean => {
  const match = quietHours.match(HOUR_RANGE_REGEX);
  if (!match) {
    return false;
  }

  const startHour = Number(match[1]);
  const endHour = Number(match[2]);
  if (!Number.isInteger(startHour) || !Number.isInteger(endHour) || startHour < 0 || startHour > 23 || endHour < 0 || endHour > 23) {
    return false;
  }

  const hourText = new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    hour12: false,
    timeZone,
  }).format(date);
  const localHour = Number(hourText);

  if (startHour === endHour) {
    return false;
  }

  if (startHour < endHour) {
    return localHour >= startHour && localHour < endHour;
  }

  return localHour >= startHour || localHour < endHour;
};

export const getSpotlightEligibility = (
  config: Config,
  input: SpotlightEligibilityInput,
  now = new Date(),
): SpotlightEligibilityResult => {
  if (!config.ticketSpotlightEnabled) {
    return { eligible: false, reason: "disabled" };
  }

  if (!config.ticketMarketplaceGroupJids.includes(input.groupJid)) {
    return { eligible: false, reason: "not_marketplace" };
  }

  if (input.fromMe) {
    return { eligible: false, reason: "from_me" };
  }

  if (input.isCommand) {
    return { eligible: false, reason: "command" };
  }

  if (input.isReply) {
    return { eligible: false, reason: "reply" };
  }

  if (input.intent === "none") {
    return { eligible: false, reason: "no_intent" };
  }

  if (input.intent === "buying" && !config.ticketSpotlightBuyingEnabled) {
    return { eligible: false, reason: "buying_disabled" };
  }

  if (input.intent === "selling" && !input.hasPrice) {
    return { eligible: false, reason: "selling_missing_price" };
  }

  const trimmed = input.text.trim();
  const minLength = input.intent === "buying"
    ? config.ticketSpotlightBuyingMinLength
    : config.ticketSpotlightMinLength;
  if (trimmed.length < minLength) {
    return { eligible: false, reason: "too_short" };
  }

  if (trimmed.length > config.ticketSpotlightMaxLength) {
    return { eligible: false, reason: "too_long" };
  }

  if (hasUrlLikeText(trimmed)) {
    return { eligible: false, reason: "url" };
  }

  if (hasPhoneLikeText(trimmed)) {
    return { eligible: false, reason: "phone_number" };
  }

  const senderJid = normaliseJid(input.senderJid);
  if (config.ticketSpotlightBlocklistJids.map(normaliseJid).includes(senderJid)) {
    return { eligible: false, reason: "blocklisted" };
  }

  if (isQuietHour(now, config.ticketSpotlightQuietHours, config.ticketSpotlightTimezone)) {
    return { eligible: false, reason: "quiet_hours" };
  }

  return { eligible: true };
};
