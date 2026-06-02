import type { WebsiteTicketExchangeListing } from "./client.js";

const trimText = (value: string, maxLength: number): string => {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const PROFANITY_PATTERNS = [
  /\bf+u+c+k+(?:e[drs]?|i+n+g+)?\b/giu,
  /\bs+h+i+t+(?:t+y+|s+)?\b/giu,
  /\bc+u+n+t+s?\b/giu,
  /\bb+i+t+c+h+(?:e[ds])?\b/giu,
  /\bb+a+s+t+a+r+d+s?\b/giu,
] as const;

const maskProfanity = (value: string): string =>
  PROFANITY_PATTERNS.reduce(
    (next, pattern) => next.replace(pattern, (match) => "*".repeat(match.length)),
    value,
  );

const formatNote = (value: string): string => {
  const note = trimText(maskProfanity(value), 140);
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
    ? "Selling on Ticket Exchange"
    : "Looking for tickets on Ticket Exchange";
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
    ? "Interested? Open the link to contact them."
    : "Got one? Open the link to contact them.";

  return `🎟️ ${heading}

${listing.eventName}
${eventDateLine ? `${eventDateLine}\n` : ""}${details}${note}

${actionLine}
${absoluteUrl(baseUrl, listing.url)}

Availability can change quickly. OOOC only connects people - please check details before paying.`;
};
