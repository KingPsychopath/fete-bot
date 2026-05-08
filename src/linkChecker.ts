// NOTE: This allowlist is intentionally hardcoded — it is business logic, not configuration.
// To change what is allowed, edit this file and redeploy. Do not move to env vars.

import { getDomain, getDomainWithoutSuffix, parse as parseDomain } from "tldts";

export const ALLOWED_DOMAINS = [
  "spotify.com",
  "music.apple.com",
  "outofofficecollective.co.uk",
  "music.youtube.com",
  "instagram.com",
  "x.com",
  "twitter.com",
  "tiktok.com",
  "soundcloud.com",
  "mixcloud.com",
  "pinterest.com",
] as const;

const ACCOMMODATION_BRAND_NAMES = new Set([
  "booking",
  "airbnb",
  "hostelworld",
  "trivago",
  "expedia",
]);

const ACCOMMODATION_EXACT_DOMAINS = new Set([
  "trip.com",
  "trip.fr",
  "hotels.com",
]);

const SHOPPING_BRAND_NAMES = new Set([
  "adidas",
  "abercrombie",
  "alo",
  "amazon",
  "arket",
  "asos",
  "bershka",
  "boohoo",
  "boohooman",
  "brandymelville",
  "byrotation",
  "cider",
  "cos",
  "depop",
  "ebay",
  "farfetch",
  "fashionnova",
  "freepeople",
  "garage",
  "goat",
  "gymshark",
  "hm",
  "hollisterco",
  "houseofcb",
  "lululemon",
  "mango",
  "meshki",
  "missguided",
  "motelrocks",
  "nastygal",
  "newlook",
  "next",
  "monki",
  "nike",
  "ohpolly",
  "pinterest",
  "primark",
  "princesspolly",
  "pullandbear",
  "riverisland",
  "revolve",
  "selfridges",
  "shein",
  "skims",
  "stockx",
  "stradivarius",
  "therealreal",
  "tkmaxx",
  "uniqlo",
  "urbanoutfitters",
  "vestiairecollective",
  "vinted",
  "weekday",
  "zalando",
  "zara",
]);

const SHOPPING_EXACT_DOMAINS = new Set([
  "endclothing.com",
  "garageclothing.com",
  "aloyoga.com",
  "marksandspencer.com",
  "prettylittlething.com",
  "shopcider.com",
  "stories.com",
]);

export const BLOCKED_DOMAINS = [
  "chat.whatsapp.com",
  "ra.co",
  "dice.fm",
  "eventbrite.com",
  "skiddle.com",
  "ticketmaster.com",
  "ticketweb.com",
  "seetickets.com",
  "billetto.co.uk",
  "fixr.co",
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "ow.ly",
  "buff.ly",
  "shorturl.at",
  "is.gd",
  "rebrand.ly",
  "cutt.ly",
  "rb.gy",
  "tiny.cc",
  "lnkd.in",
] as const;

export const SHORTENER_DOMAINS = [
  "bit.ly",
  "t.co",
  "tinyurl.com",
  "ow.ly",
  "buff.ly",
  "shorturl.at",
  "is.gd",
  "rebrand.ly",
  "cutt.ly",
  "rb.gy",
  "tiny.cc",
  "lnkd.in",
  "vm.tiktok.com",
] as const;

export type DisallowedUrlReason =
  | "not in allowlist"
  | "bare profile handle or URL"
  | "ticket platform"
  | "url shortener"
  | "tiktok video (profile links only)"
  | "youtube (music.youtube.com only)"
  | "whatsapp invite link";

const INSTAGRAM_RESERVED_SEGMENTS = new Set([
  "accounts",
  "direct",
  "explore",
  "p",
  "reel",
  "reels",
  "share",
  "stories",
  "tv",
]);

const X_RESERVED_SEGMENTS = new Set([
  "compose",
  "download",
  "explore",
  "hashtag",
  "home",
  "i",
  "intent",
  "login",
  "messages",
  "notifications",
  "search",
  "settings",
  "share",
  "signup",
]);

const URL_REGEX =
  /(?<![@\w])((?:(?:https?:\/\/(?:www\.)?|www\.)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:[/?#][^\s<>()\[\]{}"'`]+)?|(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:[/?#][^\s<>()\[\]{}"'`]+)?))/gi;

const stripTrailingPunctuation = (url: string): string =>
  url.replace(/[),.!?;:\]}'"]+$/g, "");

const toParsableUrl = (url: string): string => {
  if (/^https?:\/\//i.test(url)) {
    return url;
  }

  return `https://${url}`;
};

const parseUrl = (url: string): URL | null => {
  try {
    return new URL(toParsableUrl(url));
  } catch {
    return null;
  }
};

const matchesDomain = (domain: string, candidates: readonly string[]): boolean =>
  candidates.some((candidate) => domain === candidate || domain.endsWith(`.${candidate}`));

const isTicketPlatformDomain = (domain: string): boolean =>
  matchesDomain(domain, [
    "ra.co",
    "dice.fm",
    "eventbrite.com",
    "skiddle.com",
    "ticketmaster.com",
    "ticketweb.com",
    "seetickets.com",
    "billetto.co.uk",
    "fixr.co",
  ]);

export const extractUrls = (text: string): string[] => {
  const urls: string[] = [];

  for (const match of text.matchAll(URL_REGEX)) {
    const rawUrl = match[1];
    if (!rawUrl) {
      continue;
    }

    const startIndex = match.index ?? 0;
    const url = stripTrailingPunctuation(rawUrl);
    const hasExplicitUrlPrefix = /^(?:https?:\/\/|www\.)/i.test(url);
    const isHandleStyleText = text.slice(Math.max(0, startIndex - 2), startIndex) === "@/";
    const parsedDomain = parseDomain(url);

    if (!hasExplicitUrlPrefix && (isHandleStyleText || !parsedDomain.isIcann)) {
      continue;
    }

    urls.push(url);
  }

  return urls;
};

export const normaliseDomain = (url: string): string => {
  const parsed = parseUrl(url);
  return parsed?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
};

export const isShortener = (url: string): boolean => {
  const domain = normaliseDomain(url);
  return domain.length > 0 && matchesDomain(domain, SHORTENER_DOMAINS);
};

const isExplicitUrl = (url: string): boolean => /^(?:https?:\/\/|www\.)/i.test(url);

const isBareDomainOnly = (url: string): boolean => {
  if (isExplicitUrl(url) || /[/?#]/u.test(url)) {
    return false;
  }

  const parsedDomain = parseDomain(url);
  return Boolean(parsedDomain.isIcann && parsedDomain.domain && parsedDomain.hostname === parsedDomain.domain);
};

export const isTikTokProfileUrl = (url: string): boolean => {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }

  const domain = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (domain !== "tiktok.com") {
    return false;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  return segments.length === 1 && /^@[^/]+$/i.test(segments[0] ?? "");
};

const hasSingleProfileSegment = (url: string, reservedSegments: Set<string>): boolean => {
  const parsed = parseUrl(url);
  if (!parsed) {
    return false;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length !== 1) {
    return false;
  }

  const [segment] = segments;
  return Boolean(segment) && !reservedSegments.has(segment.toLowerCase());
};

const isInstagramProfileUrl = (url: string): boolean => {
  const domain = normaliseDomain(url);
  if (domain !== "instagram.com") {
    return false;
  }

  return hasSingleProfileSegment(url, INSTAGRAM_RESERVED_SEGMENTS);
};

const isXProfileUrl = (url: string, domainName: "x.com" | "twitter.com"): boolean => {
  const domain = normaliseDomain(url);
  if (domain !== domainName) {
    return false;
  }

  return hasSingleProfileSegment(url, X_RESERVED_SEGMENTS);
};

const isAccommodationDomain = (domain: string): boolean => {
  const registeredDomain = getDomain(domain);
  if (!registeredDomain) {
    return false;
  }

  if (ACCOMMODATION_EXACT_DOMAINS.has(registeredDomain)) {
    return true;
  }

  const registeredName = getDomainWithoutSuffix(domain);
  return Boolean(registeredName && ACCOMMODATION_BRAND_NAMES.has(registeredName));
};

const isShoppingDomain = (domain: string): boolean => {
  const registeredDomain = getDomain(domain);
  if (!registeredDomain) {
    return false;
  }

  if (SHOPPING_EXACT_DOMAINS.has(registeredDomain)) {
    return true;
  }

  const registeredName = getDomainWithoutSuffix(domain);
  return Boolean(registeredName && SHOPPING_BRAND_NAMES.has(registeredName));
};

const isAllowedDomain = (domain: string, url: string): boolean => {
  if (domain === "music.apple.com" || domain === "music.youtube.com") {
    return true;
  }

  if (domain === "spotify.com" || domain === "open.spotify.com") {
    return true;
  }

  if (domain === "instagram.com") {
    return isInstagramProfileUrl(url);
  }

  if (domain === "x.com") {
    return isXProfileUrl(url, "x.com");
  }

  if (domain === "twitter.com") {
    return isXProfileUrl(url, "twitter.com");
  }

  if (domain === "soundcloud.com" || domain.endsWith(".soundcloud.com")) {
    return true;
  }

  if (domain === "mixcloud.com" || domain.endsWith(".mixcloud.com")) {
    return true;
  }

  if (domain === "pinterest.com" || domain.endsWith(".pinterest.com")) {
    return true;
  }

  if (isAccommodationDomain(domain)) {
    return true;
  }

  if (isShoppingDomain(domain)) {
    return true;
  }

  return (
    domain === "outofofficecollective.co.uk" || domain.endsWith(".outofofficecollective.co.uk")
  );
};

export const isAllowed = (url: string): boolean => {
  const domain = normaliseDomain(url);

  if (domain.length === 0 || matchesDomain(domain, BLOCKED_DOMAINS) || isShortener(url)) {
    return false;
  }

  if (domain === "youtube.com" || domain.endsWith(".youtube.com")) {
    return domain === "music.youtube.com";
  }

  if (domain === "youtu.be") {
    return false;
  }

  if (domain === "tiktok.com") {
    return isTikTokProfileUrl(url);
  }

  if (domain === "vm.tiktok.com") {
    return false;
  }

  return isAllowedDomain(domain, url);
};

const getDisallowedReason = (url: string): DisallowedUrlReason => {
  const domain = normaliseDomain(url);

  if (domain.length === 0) {
    return "not in allowlist";
  }

  if (isShortener(url) || matchesDomain(domain, SHORTENER_DOMAINS)) {
    return "url shortener";
  }

  if (isTicketPlatformDomain(domain)) {
    return "ticket platform";
  }

  if (domain === "chat.whatsapp.com") {
    return "whatsapp invite link";
  }

  if (domain === "youtube.com" || domain.endsWith(".youtube.com") || domain === "youtu.be") {
    return "youtube (music.youtube.com only)";
  }

  if (domain === "vm.tiktok.com" || domain === "tiktok.com") {
    return "tiktok video (profile links only)";
  }

  if (isBareDomainOnly(url)) {
    return "bare profile handle or URL";
  }

  return "not in allowlist";
};

export const containsDisallowedUrl = (
  text: string,
): { found: boolean; url?: string; reason?: DisallowedUrlReason } => {
  for (const url of extractUrls(text)) {
    if (!isAllowed(url)) {
      return { found: true, url, reason: getDisallowedReason(url) };
    }
  }

  return { found: false };
};

/*
Quick checks:
- isAllowed("https://open.spotify.com/track/abc") => true
- isAllowed("https://fete.outofofficecollective.co.uk") => true
- isAllowed("https://music.youtube.com/watch?v=123") => true
- isAllowed("https://www.youtube.com/watch?v=123") => false
- isAllowed("https://airbnb.fr/rooms/123") => true
- isTikTokProfileUrl("https://tiktok.com/@username") => true
- isTikTokProfileUrl("https://tiktok.com/@username/video/123") => false
- containsDisallowedUrl("visit https://ra.co/events/1") => { found: true, reason: "ticket platform" }
*/
