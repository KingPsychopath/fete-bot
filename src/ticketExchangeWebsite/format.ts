import type { WebsiteTicketExchangeListing } from "./client.js";

const trimText = (value: string, maxLength: number): string => {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const NOTE_REMOVED_TEXT = "[removed for language]";

const COMPACT_NOTE_BLOCKLIST = [
  "fuck",
  "fucker",
  "fucked",
  "fucking",
  "shit",
  "shitty",
  "cunt",
  "bitch",
  "bitches",
  "bastard",
  "nigger",
  "nigga",
  "kike",
  "faggot",
  "fag",
  "tranny",
  "retard",
  "spastic",
  "paki",
  "chink",
  "gook",
  "coon",
  "dyke",
  "nazi",
] as const;

const leetspeakMap: Record<string, string> = {
  "0": "o",
  "1": "i",
  "3": "e",
  "4": "a",
  "5": "s",
  "7": "t",
  "8": "b",
  "@": "a",
  "$": "s",
  "!": "i",
};

const normaliseAbuseScanText = (value: string): string =>
  value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase()
    .replace(/[0134578@$!]/gu, (match) => leetspeakMap[match] ?? match)
    .replace(/(.)\1{2,}/gu, "$1$1");

const getCompactScanText = (value: string): string =>
  normaliseAbuseScanText(value).replace(/[^a-z0-9]+/gu, "");

const hasBlockedNoteLanguage = (value: string): boolean => {
  const compact = getCompactScanText(value);
  if (COMPACT_NOTE_BLOCKLIST.some((term) => compact.includes(term))) {
    return true;
  }

  const normalised = normaliseAbuseScanText(value);
  return /\b(?:kill\s+yourself|gas\s+(?:the\s+)?(?:jews|black|blacks|muslims|gays)|white\s+power|heil\s+hitler)\b/iu.test(normalised);
};

const formatNote = (value: string): string => {
  const note = hasBlockedNoteLanguage(value) ? NOTE_REMOVED_TEXT : trimText(value, 140);
  return note ? `\nNote: ${note}` : "";
};

const absoluteUrl = (baseUrl: string, listingUrl: string): string => {
  if (/^https?:\/\//iu.test(listingUrl)) {
    return listingUrl;
  }
  return `${baseUrl.replace(/\/+$/u, "")}${listingUrl.startsWith("/") ? listingUrl : `/${listingUrl}`}`;
};

const LONDON_TIME_ZONE = "Europe/London";

const getLondonDateKey = (date: Date): string =>
  new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(date);

const formatExpiry = (value: string, now = new Date()): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  const time = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);

  if (getLondonDateKey(date) === getLondonDateKey(now)) {
    return `today, ${time}`;
  }

  const day = new Intl.DateTimeFormat("en-GB", {
    timeZone: LONDON_TIME_ZONE,
    day: "2-digit",
    month: "short",
  }).format(date);

  return `${day}, ${time}`;
};

const formatQuantity = (value: string): string => {
  const trimmed = value.trim();
  return /^\d+$/u.test(trimmed) ? `Qty x${trimmed}` : `Qty ${trimmed}`;
};

export const buildWebsiteTicketExchangeAnnouncement = (
  baseUrl: string,
  listing: WebsiteTicketExchangeListing,
): string => {
  const heading = listing.listingType === "selling"
    ? "Ticket listed"
    : "Ticket request";
  const priceText = listing.priceLabel
    ? listing.listingType === "selling"
      ? listing.priceLabel
      : `Budget ${listing.priceLabel}`
    : "";
  const eventDateLine = listing.eventDateLabel?.trim() || "";
  const note = listing.note ? formatNote(listing.note) : "";
  const expiryLine = formatExpiry(listing.expiresAt);
  const details = [
    [formatQuantity(listing.quantityLabel), priceText].filter(Boolean).join(" · "),
    expiryLine ? `Visible until ${expiryLine}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  const actionLine = listing.listingType === "selling"
    ? "Interested? Use the link to reply."
    : "Got one? Use the link to reply.";

  return `🎟️ ${heading}

${listing.eventName}
${eventDateLine ? `${eventDateLine}\n` : ""}${details}${note}

${actionLine}
${absoluteUrl(baseUrl, listing.url)}

Availability can change quickly. Please check details before paying.`;
};
