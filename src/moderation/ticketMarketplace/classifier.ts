import { hasExplicitPrice, hasValidPrice } from "./price.js";

export type TicketMarketplaceIntent = "none" | "buying" | "selling";

export type TicketMarketplaceClassification = {
  intent: TicketMarketplaceIntent;
  matchedTokens: string[];
  matchedSignals: {
    buy: string[];
    sell: string[];
    dominance: "buy" | "sell" | "none";
  };
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
  "zoek",
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

const ticketTermPattern = String.raw`(?:ticket|tickets|tix|pass|passes|wristband|wristbands|billet|billets|place|places|bracelet|bracelets|entree|entrée|entrada|entradas|boleto|boletos|billete|billetes|biglietto|biglietti|karte|karten|kaartje|kaartjes|bilet|bilety)`;

const STRONG_BUY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "anyone selling",
    regex: /\b(?:hey\s+)?(?:if\s+)?(?:anyone|anybody|any1|someone|somebody)\s+(?:is\s+)?selling(?:\s+(?:please\s+dm\s+me|please|pls|lmk|dm\s+me|let\s+me\s+know|looking\s+for\s+(?:one|1|two|2)))*$/iu,
  },
  {
    label: "anyone selling ticket",
    regex: new RegExp(
      String.raw`\b(?:if\s+)?(?:anyone|anybody|any1|someone|somebody)\s+(?:is\s+)?selling\s+(?:[\p{L}\p{N}]+\s+){0,4}${ticketTermPattern}\b`,
      "iu",
    ),
  },
  {
    label: "is anyone selling",
    regex: /\bis\s+(?:anyone|anybody|any1|someone|somebody)\s+selling\b/iu,
  },
  {
    label: "lmk if anyone selling",
    regex: /\blmk\s+if\s+(?:anyone|anybody|any1|someone|somebody)\s+(?:is\s+)?selling\b/iu,
  },
  {
    label: "anyone got spare",
    regex: new RegExp(
      String.raw`\b(?:does\s+)?(?:anyone|anybody|any1|someone|somebody)\s+(?:got|has|have)\s+(?:a\s+|an\s+|\d+\s+)?(?:spare|extra|(?:[\p{L}\p{N}]+\s+){0,3}${ticketTermPattern})\b`,
      "iu",
    ),
  },
  { label: "ISO", regex: /\biso\b/iu },
  { label: "in search of", regex: /\bin\s+search\s+of\b/iu },
  { label: "quelqu'un vend", regex: /\b(?:quelqu'un|qqn)\s+vend\b/iu },
  { label: "qui vend", regex: /\bqui\s+vend\b/iu },
  {
    label: "looking for ticket",
    regex: new RegExp(String.raw`\blooking\s+for\s+(?:a\s+|\d+\s+)?${ticketTermPattern}\b`, "iu"),
  },
];

const BUYER_INTENT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "lmk", regex: /\blmk\b/iu },
  { label: "let me know", regex: /\b(?:please\s+|pls\s+)?let\s+me\s+know\b/iu },
  { label: "looking to buy", regex: /\blooking\s+to\s+buy\b/iu },
  { label: "trying to find", regex: /\btrying\s+to\s+find\b/iu },
  { label: "trying to get", regex: /\btrying\s+to\s+get\b/iu },
  { label: "please dm", regex: /\b(?:please|pls)\s+dm\b/iu },
  { label: "dm me if", regex: /\bdm\s+me\s+if\b/iu },
  { label: "happy to pay", regex: /\bhappy\s+to\s+pay\b/iu },
  { label: "will pay", regex: /\bwill\s+pay\b/iu },
  { label: "can pay", regex: /\bcan\s+pay\b/iu },
  { label: "faites-moi savoir", regex: /\bfaites\s+moi\s+savoir\b/iu },
  { label: "je cherche", regex: /\bje\s+cherche\b/iu },
  { label: "je veux acheter", regex: /\bje\s+veux\s+acheter\b/iu },
];

const normaliseText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[🎟🎫]/gu, " ticket ")
    .replace(/[’‘`´]/gu, "'")
    .replace(/[?!.,;:()[\]{}"“”]+/gu, " ")
    .replace(/[^\p{L}\p{N}'£€$]+/gu, " ")
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

const findPatternMatches = (
  text: string,
  patterns: ReadonlyArray<{ label: string; regex: RegExp }>,
): string[] => patterns.filter((pattern) => pattern.regex.test(text)).map((pattern) => pattern.label);

const hasNearbyMatch = (
  leftMatches: readonly TokenMatch[],
  rightMatches: readonly TokenMatch[],
  maxDistance: number,
): boolean =>
  leftMatches.some((left) =>
    rightMatches.some((right) => Math.abs(left.index - right.index) <= maxDistance),
  );

const hasGotTicketsSellingIntent = (
  normalisedText: string,
  hasAvailabilityCue: boolean,
  pricePresentBeforeIntent: boolean,
): boolean => {
  const regex = /\bgot\s+\d+\s+(?:ticket|tickets|tix|pass|passes|billet|billets|place|places)\b/iu;
  if (!regex.test(normalisedText)) {
    return false;
  }

  return hasAvailabilityCue || pricePresentBeforeIntent;
};

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const emptySignals = (): TicketMarketplaceClassification["matchedSignals"] => ({
  buy: [],
  sell: [],
  dominance: "none",
});

const hasBuyerStartContext = (normalisedText: string): boolean =>
  /^(?:hey\s+)?(?:if|does|is|anyone|anybody|any1|someone|somebody|looking|iso|need|want|cherche|je\s+cherche)\b/iu.test(
    normalisedText,
  );

const hasPleaseTicketContext = (normalisedText: string, ticketMatches: readonly TokenMatch[]): boolean =>
  /\bplease\b/iu.test(normalisedText) && ticketMatches.length > 0;

export const classify = (text: string): TicketMarketplaceClassification => {
  const rawEndsWithQuestionMark = /[?？]\s*$/u.test(text);
  const normalisedText = normaliseText(text);

  if (!normalisedText) {
    return { intent: "none", matchedTokens: [], matchedSignals: emptySignals(), hasPrice: false };
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

  const buySignals: string[] = [];
  const sellSignals: string[] = [];
  const strongBuySignals = findPatternMatches(normalisedText, STRONG_BUY_PATTERNS);
  const buyerIntentSignals = findPatternMatches(normalisedText, BUYER_INTENT_PATTERNS);
  buySignals.push(...strongBuySignals);

  if (hasNearbyMatch(weakBuyMatches, ticketMatches, 6)) {
    buySignals.push(...weakBuyMatches.map((match) => match.token));
    buySignals.push(...ticketMatches.map((match) => match.token));
  }

  const strongSell =
    hasAnyPhrase(normalisedText, STRONG_SELL_PHRASES, sellSignals) ||
    hasAnyRegex(normalisedText, STRONG_SELL_REGEXES, sellSignals);
  const priceTicketSelling = pricePresentBeforeIntent && ticketMatches.length > 0;

  if (
    buyerIntentSignals.length > 0 &&
    (ticketMatches.length > 0 || strongBuySignals.length > 0 || hasDirectSellVerb || strongSell || pricePresentBeforeIntent)
  ) {
    buySignals.push(...buyerIntentSignals);
  }
  const cantGoSelling = CANT_GO_REGEX.test(normalisedText) && ticketMatches.length > 0;
  const weakSell =
    hasNearbyMatch(weakSellMatches, ticketMatches, 6) &&
    (hasAvailabilityCue || pricePresentBeforeIntent || hasDirectSellVerb);
  const gotTicketsSelling = hasGotTicketsSellingIntent(
    normalisedText,
    hasAvailabilityCue,
    pricePresentBeforeIntent,
  );

  if (strongSell || cantGoSelling || weakSell || gotTicketsSelling || priceTicketSelling) {
    if (cantGoSelling) {
      sellSignals.push("can't go");
      sellSignals.push(...ticketMatches.map((match) => match.token));
    }

    if (weakSell) {
      sellSignals.push(...weakSellMatches.map((match) => match.token));
      sellSignals.push(...ticketMatches.map((match) => match.token));
      sellSignals.push(...availabilityMatches.map((match) => match.token));
    }

    if (gotTicketsSelling) {
      sellSignals.push("got N tickets");
    }

    if (priceTicketSelling) {
      sellSignals.push("price");
      sellSignals.push(...ticketMatches.map((match) => match.token));
    }
  }

  if (buySignals.length > 0 && hasDirectSellVerb) {
    sellSignals.push(
      ...weakSellMatches
        .filter((match) => ["selling", "sell", "vends", "vend", "vendo", "verkaufe", "te koop"].includes(match.token))
        .map((match) => match.token),
    );
  }

  const hasBuySignals = buySignals.length > 0;
  const hasSellSignals = sellSignals.length > 0;
  const buyDominates =
    hasBuySignals &&
    hasSellSignals &&
    (strongBuySignals.length > 0 ||
      buyerIntentSignals.length > 0 ||
      rawEndsWithQuestionMark ||
      hasBuyerStartContext(normalisedText) ||
      hasPleaseTicketContext(normalisedText, ticketMatches));

  if (hasBuySignals && (!hasSellSignals || buyDominates)) {
    const matchedSignals = {
      buy: unique(buySignals),
      sell: unique(sellSignals),
      dominance: hasSellSignals ? ("buy" as const) : ("none" as const),
    };
    return {
      intent: "buying",
      matchedTokens: unique([...matchedSignals.buy, ...matchedSignals.sell]),
      matchedSignals,
      hasPrice: hasValidPrice(normalisedText, "buying"),
    };
  }

  if (hasSellSignals) {
    const matchedSignals = {
      buy: unique(buySignals),
      sell: unique(sellSignals),
      dominance: hasBuySignals ? ("sell" as const) : ("none" as const),
    };
    return {
      intent: "selling",
      matchedTokens: unique([...matchedSignals.sell, ...matchedSignals.buy]),
      matchedSignals,
      hasPrice: hasValidPrice(normalisedText, "selling"),
    };
  }

  return { intent: "none", matchedTokens: [], matchedSignals: emptySignals(), hasPrice: false };
};
