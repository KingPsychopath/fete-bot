// NOTE: This allowlist is intentionally hardcoded — it is business logic, not configuration.
// To change what is allowed, edit this file and redeploy. Do not move to env vars.

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
] as const;

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
  | "ticket platform"
  | "url shortener"
  | "tiktok video (profile links only)"
  | "youtube (music.youtube.com only)"
  | "whatsapp invite link";

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
  const matches = Array.from(text.matchAll(URL_REGEX), (match) => match[1]);
  return matches.map(stripTrailingPunctuation);
};

export const normaliseDomain = (url: string): string => {
  const parsed = parseUrl(url);
  return parsed?.hostname.toLowerCase().replace(/^www\./, "") ?? "";
};

export const isShortener = (url: string): boolean => {
  const domain = normaliseDomain(url);
  return domain.length > 0 && matchesDomain(domain, SHORTENER_DOMAINS);
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

const isAllowedDomain = (domain: string): boolean => {
  if (domain === "music.apple.com" || domain === "music.youtube.com") {
    return true;
  }

  if (domain === "spotify.com" || domain === "open.spotify.com") {
    return true;
  }

  if (domain === "instagram.com" || domain.endsWith(".instagram.com")) {
    return true;
  }

  if (domain === "x.com" || domain.endsWith(".x.com")) {
    return true;
  }

  if (domain === "twitter.com" || domain.endsWith(".twitter.com")) {
    return true;
  }

  if (domain === "soundcloud.com" || domain.endsWith(".soundcloud.com")) {
    return true;
  }

  if (domain === "mixcloud.com" || domain.endsWith(".mixcloud.com")) {
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

  return isAllowedDomain(domain);
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
- isTikTokProfileUrl("https://tiktok.com/@username") => true
- isTikTokProfileUrl("https://tiktok.com/@username/video/123") => false
- containsDisallowedUrl("visit https://ra.co/events/1") => { found: true, reason: "ticket platform" }
*/
