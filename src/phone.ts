import { parsePhoneNumberFromString, type CountryCode, type NumberType } from "libphonenumber-js/max";

const normaliseRegion = (value: string | undefined): CountryCode | undefined => {
  const trimmed = value?.trim().toUpperCase();
  if (!trimmed || !/^[A-Z]{2}$/.test(trimmed)) {
    return undefined;
  }

  return trimmed as CountryCode;
};

export const DEFAULT_PHONE_REGION = normaliseRegion(process.env.DEFAULT_PHONE_REGION);

export type PhoneParseFailureReason =
  | "empty"
  | "ambiguous_number"
  | "no_default_region"
  | "unparseable"
  | "invalid_for_region"
  | `not_mobile:${NumberType}`;

export type PhoneParseResult =
  | {
      ok: true;
      e164: string;
      jid: string;
      country: CountryCode | undefined;
      type: NumberType | "UNKNOWN";
    }
  | {
      ok: false;
      reason: PhoneParseFailureReason;
      hint?: string;
    };

const MOBILE_COMPATIBLE_TYPES = new Set<NumberType | undefined>(["MOBILE", "FIXED_LINE_OR_MOBILE", undefined]);

const normalisePhoneInputText = (value: string): string =>
  value
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .replace(/[\uFE62\uFF0B\u2795]/gu, "+");

const stripFormatting = (value: string): string => normalisePhoneInputText(value).replace(/[\s().-]/g, "");

export const jidFromE164 = (e164: string): string => `${e164.slice(1)}@s.whatsapp.net`;

export const parseHumanPhoneInput = (raw: string): PhoneParseResult => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return { ok: false, reason: "empty" };
  }

  const compact = stripFormatting(trimmed);
  if (!/^(?:\+|00)?\d+$/.test(compact)) {
    return {
      ok: false,
      reason: "unparseable",
      hint: "Use only the phone number as the identifier, then put any reason after a space.",
    };
  }

  const hasIntlPrefix = compact.startsWith("+") || compact.startsWith("00");
  const hasLeadingZero = /^0\d/.test(compact);

  if (!hasIntlPrefix && !hasLeadingZero) {
    return {
      ok: false,
      reason: "ambiguous_number",
      hint: "Use international format like +447768986864, or a leading-zero national number if DEFAULT_PHONE_REGION is configured.",
    };
  }

  if (hasLeadingZero && !DEFAULT_PHONE_REGION) {
    return {
      ok: false,
      reason: "no_default_region",
      hint: "Use international format like +447768986864 or set DEFAULT_PHONE_REGION.",
    };
  }

  const parsed = parsePhoneNumberFromString(
    compact.replace(/^00/, "+"),
    hasLeadingZero ? DEFAULT_PHONE_REGION : undefined,
  );

  if (!parsed) {
    return { ok: false, reason: "unparseable" };
  }

  if (!parsed.isValid()) {
    return { ok: false, reason: "invalid_for_region" };
  }

  const type = parsed.getType();
  if (!MOBILE_COMPATIBLE_TYPES.has(type)) {
    return { ok: false, reason: `not_mobile:${type}` };
  }

  return {
    ok: true,
    e164: parsed.number,
    jid: jidFromE164(parsed.number),
    country: parsed.country,
    type: type ?? "UNKNOWN",
  };
};

export const normalizeTrustedPhoneToJid = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }

  const lower = trimmed.toLowerCase();
  if (lower.endsWith("@s.whatsapp.net")) {
    const digits = lower.replace(/@s\.whatsapp\.net$/i, "");
    return /^\d{7,15}$/.test(digits) ? `${digits}@s.whatsapp.net` : null;
  }

  if (lower.endsWith("@lid") || lower.endsWith("@g.us")) {
    return null;
  }

  const compact = stripFormatting(trimmed);
  if (/^\d{7,15}$/.test(compact) && !compact.startsWith("0")) {
    return `${compact}@s.whatsapp.net`;
  }

  const parsed = parseHumanPhoneInput(trimmed);
  return parsed.ok ? parsed.jid : null;
};
