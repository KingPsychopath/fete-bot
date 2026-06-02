import type { WebsiteTicketExchangeListing } from "./client.js";

const trimText = (value: string, maxLength: number): string => {
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
};

const absoluteUrl = (baseUrl: string, listingUrl: string): string => {
  if (/^https?:\/\//iu.test(listingUrl)) {
    return listingUrl;
  }
  return `${baseUrl.replace(/\/+$/u, "")}${listingUrl.startsWith("/") ? listingUrl : `/${listingUrl}`}`;
};

const formatExpiry = (value: string): string => {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    return "";
  }

  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    day: "2-digit",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
};

export const buildWebsiteTicketExchangeAnnouncement = (
  baseUrl: string,
  listing: WebsiteTicketExchangeListing,
): string => {
  const mode = listing.listingType === "selling" ? "Selling" : "Looking";
  const priceText = listing.priceLabel
    ? listing.listingType === "selling"
      ? listing.priceLabel
      : `Budget ${listing.priceLabel}`
    : "";
  const note = listing.note ? `\n${trimText(listing.note, 140)}` : "";
  const expiryLine = formatExpiry(listing.expiresAt);
  const details = [
    [listing.quantityLabel, priceText].filter(Boolean).join(" · "),
    expiryLine ? `Visible until ${expiryLine}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  return `🎟️ ${mode} on Ticket Exchange

${listing.eventName}
${details}${note}

Unlock contact:
${absoluteUrl(baseUrl, listing.url)}

Availability may change. OOOC connects people only; check before paying.`;
};
