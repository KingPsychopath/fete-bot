import { hasExplicitPrice, hasValidPrice } from "./price.js";

export type TicketMarketplaceIntent = "none" | "buying" | "selling";

export type TicketMarketplaceClassification = {
  intent: TicketMarketplaceIntent;
  matchedTokens: string[];
  hasPrice: boolean;
};

type TokenMatch = {
  token: string;
  index: number;
};

const TICKET_TERMS = [
  "ticket",
  "tickets",
  "tix",
  "pass",
  "passes",
  "wristband",
  "wristbands",
  "billet",
  "billets",
  "place",
  "places",
  "bracelet",
  "bracelets",
  "entrée",
  "entree",
  "entrada",
  "entradas",
  "boleto",
  "boletos",
  "billete",
  "billetes",
  "biglietto",
  "biglietti",
  "karte",
  "karten",
  "kaartje",
  "kaartjes",
  "bilet",
  "bilety",
] as const;

const WEAK_BUY_TERMS = [
  "buy",
  "need",
  "want",
  "after",
  "looking for",
  "cherche",
  "recherche",
  "besoin",
  "busco",
  "compro",
  "cerco",
  "suche",
] as const;

const WEAK_SELL_TERMS = [
  "selling",
  "sell",
  "available",
  "spare",
  "extra",
  "vends",
  "vend",
  "vendo",
  "verkaufe",
  "te koop",
] as const;

const AVAILABILITY_CUES = [
  "spare",
  "extra",
  "dm me",
  "pm me",
  "message me",
  "available",
  "can't go",
  "cannot go",
  "can't make it",
] as const;

const STRONG_SELL_PHRASES = ["for sale", "à vendre", "a vendre", "en venta", "face value"] as const;
const STRONG_SELL_REGEXES = [/\bfv\b/iu];
const CANT_GO_REGEX = /\b(?:can't\s+go|cannot\s+go|can't\s+make\s+it)\b/iu;

const normaliseText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[’‘`´]/gu, "'")
    .replace(/[?!.,;:()[\]{}"“”]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

const escapeRegex = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const phraseRegex = (phrase: string): RegExp =>
  new RegExp(String.raw`(?:^|\s)${escapeRegex(phrase).replace(/\s+/g, String.raw`\s+`)}(?:$|\s)`, "iu");

const tokenise = (text: string): string[] => text.match(/[\p{L}\p{N}']+/gu) ?? [];

const findTermMatches = (tokens: readonly string[], terms: readonly string[]): TokenMatch[] => {
  const matches: TokenMatch[] = [];

  for (const term of terms) {
    const termTokens = term.split(/\s+/u);
    for (let index = 0; index <= tokens.length - termTokens.length; index += 1) {
      const candidate = tokens.slice(index, index + termTokens.length).join(" ");
      if (candidate === term) {
        matches.push({ token: term, index });
      }
    }
  }

  return matches;
};

const hasPhrase = (text: string, phrase: string): boolean => phraseRegex(phrase).test(text);

const hasAnyPhrase = (text: string, phrases: readonly string[], matchedTokens: string[]): boolean => {
  let found = false;

  for (const phrase of phrases) {
    if (hasPhrase(text, phrase)) {
      matchedTokens.push(phrase);
      found = true;
    }
  }

  return found;
};

const hasAnyRegex = (text: string, regexes: readonly RegExp[], matchedTokens: string[]): boolean => {
  let found = false;

  for (const regex of regexes) {
    const match = text.match(regex);
    if (match?.[0]) {
      matchedTokens.push(match[0]);
      found = true;
    }
  }

  return found;
};

const hasNearbyMatch = (
  leftMatches: readonly TokenMatch[],
  rightMatches: readonly TokenMatch[],
  maxDistance: number,
): boolean =>
  leftMatches.some((left) =>
    rightMatches.some((right) => Math.abs(left.index - right.index) <= maxDistance),
  );

const hasStrongBuyIntent = (normalisedText: string, matchedTokens: string[]): boolean => {
  const strongBuyPatterns: Array<{ label: string; regex: RegExp }> = [
    { label: "anyone selling", regex: /\banyone\s+selling\b/iu },
    { label: "anyone got a spare", regex: /\banyone\s+got\s+a\s+spare\b/iu },
    { label: "anyone have a spare", regex: /\banyone\s+have\s+a\s+spare\b/iu },
    { label: "ISO", regex: /\biso\b/iu },
    { label: "in search of", regex: /\bin\s+search\s+of\b/iu },
    { label: "quelqu'un vend", regex: /\bquelqu'un\s+vend\b/iu },
    { label: "qui vend", regex: /\bqui\s+vend\b/iu },
    {
      label: "looking for ticket",
      regex: /\blooking\s+for\s+(?:a\s+)?(?:ticket|tickets|tix|pass|passes|billet|billets|place|places)\b/iu,
    },
    {
      label: "anyone got ticket for sale",
      regex: /\banyone\s+got\s+(?:a\s+|an\s+|\d+\s+)?(?:sunday\s+|saturday\s+|weekend\s+)?(?:ticket|tickets|tix|pass|passes|billet|billets|place|places)\s+for\s+sale\b/iu,
    },
  ];

  let found = false;
  for (const pattern of strongBuyPatterns) {
    if (pattern.regex.test(normalisedText)) {
      matchedTokens.push(pattern.label);
      found = true;
    }
  }

  return found;
};

const hasGotTicketsSellingIntent = (
  normalisedText: string,
  hasAvailabilityCue: boolean,
  pricePresentBeforeIntent: boolean,
  matchedTokens: string[],
): boolean => {
  const regex = /\bgot\s+\d+\s+(?:ticket|tickets|tix|pass|passes|billet|billets|place|places)\b/iu;
  if (!regex.test(normalisedText)) {
    return false;
  }

  matchedTokens.push("got N tickets");
  return hasAvailabilityCue || pricePresentBeforeIntent;
};

export const classify = (text: string): TicketMarketplaceClassification => {
  const normalisedText = normaliseText(text);
  const matchedTokens: string[] = [];

  if (!normalisedText) {
    return { intent: "none", matchedTokens, hasPrice: false };
  }

  const tokens = tokenise(normalisedText);
  const ticketMatches = findTermMatches(tokens, TICKET_TERMS);
  const weakBuyMatches = findTermMatches(tokens, WEAK_BUY_TERMS);
  const weakSellMatches = findTermMatches(tokens, WEAK_SELL_TERMS);
  const availabilityMatches = findTermMatches(tokens, AVAILABILITY_CUES);
  const pricePresentBeforeIntent = hasExplicitPrice(normalisedText);
  const hasAvailabilityCue = availabilityMatches.length > 0;
  const hasDirectSellVerb = weakSellMatches.some((match) =>
    ["selling", "sell", "vends", "vend", "vendo", "verkaufe", "te koop"].includes(match.token),
  );

  if (hasStrongBuyIntent(normalisedText, matchedTokens)) {
    return { intent: "buying", matchedTokens, hasPrice: hasValidPrice(normalisedText, "buying") };
  }

  if (hasNearbyMatch(weakBuyMatches, ticketMatches, 6)) {
    matchedTokens.push(...weakBuyMatches.map((match) => match.token));
    matchedTokens.push(...ticketMatches.map((match) => match.token));
    return { intent: "buying", matchedTokens: Array.from(new Set(matchedTokens)), hasPrice: hasValidPrice(normalisedText, "buying") };
  }

  const strongSell =
    hasAnyPhrase(normalisedText, STRONG_SELL_PHRASES, matchedTokens) ||
    hasAnyRegex(normalisedText, STRONG_SELL_REGEXES, matchedTokens);
  const cantGoSelling = CANT_GO_REGEX.test(normalisedText) && ticketMatches.length > 0;
  const weakSell =
    hasNearbyMatch(weakSellMatches, ticketMatches, 6) &&
    (hasAvailabilityCue || pricePresentBeforeIntent || hasDirectSellVerb);
  const gotTicketsSelling = hasGotTicketsSellingIntent(
    normalisedText,
    hasAvailabilityCue,
    pricePresentBeforeIntent,
    matchedTokens,
  );

  if (strongSell || cantGoSelling || weakSell || gotTicketsSelling) {
    if (cantGoSelling) {
      matchedTokens.push("can't go");
      matchedTokens.push(...ticketMatches.map((match) => match.token));
    }

    if (weakSell) {
      matchedTokens.push(...weakSellMatches.map((match) => match.token));
      matchedTokens.push(...ticketMatches.map((match) => match.token));
      matchedTokens.push(...availabilityMatches.map((match) => match.token));
    }

    const uniqueMatches = Array.from(new Set(matchedTokens));
    return { intent: "selling", matchedTokens: uniqueMatches, hasPrice: hasValidPrice(normalisedText, "selling") };
  }

  return { intent: "none", matchedTokens: [], hasPrice: false };
};
