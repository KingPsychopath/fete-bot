import { hasExplicitPrice, hasValidPrice } from "./price.js";

export type TicketMarketplaceIntent = "none" | "buying" | "selling";
export type MarketplaceConfidence = "low" | "medium" | "high";

export type TicketMarketplaceClassification = {
  intent: TicketMarketplaceIntent;
  confidence: MarketplaceConfidence;
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

const AMBIGUOUS_ACCESS_TERMS = new Set(["pass", "passes", "place", "places"]);

const ACCESS_CONTEXT_TERMS = new Set([
  "friday",
  "fri",
  "saturday",
  "sat",
  "sunday",
  "sun",
  "weekend",
  "day",
  "night",
  "event",
  "festival",
  "fete",
  "fête",
  "sixtion",
  "sixton",
  "samedi",
  "dimanche",
  "sabado",
  "sábado",
  "domingo",
  "samstag",
  "sonntag",
]);

const NON_TICKET_ACCESS_CONTEXT_TERMS = new Set([
  "bus",
  "gym",
  "lime",
  "metro",
  "parking",
  "rail",
  "subway",
  "train",
  "travel",
  "tube",
]);

const NON_TRANSACTION_TICKET_CONTEXT_TERMS = new Set([
  "advice",
  "help",
  "info",
  "information",
]);

const WEAK_BUY_TERMS = [
  "buy",
  "need",
  "want",
  "after",
  "looking for",
  "searching for",
  "seeking",
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
const pricePattern = String.raw`(?:[£€$]\s*)?\d+[\d.,]*(?:\s*[£€$])?`;
const thirdPartyActorPattern = String.raw`(?:(?:these|those)\s+(?:ppl|people|guys|lot|sellers)|someone|somebody|they|he|she|a\s+(?:guy|girl|person|seller)|this\s+(?:guy|girl|person|seller))`;
const thirdPartyPluralActorPattern = String.raw`(?:(?:these|those)\s+(?:ppl|people|guys|lot|sellers)|people|ppl|they|sellers)`;

const STRONG_BUY_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "anyone selling",
    regex: /\b(?:hey\s+)?(?:if\s+)?(?:anyone|anybody|any1|someone|somebody)\s+(?:is\s+)?selling(?:\s+(?:please\s+dm\s+me|please|pls|lmk|dm\s+me|let\s+me\s+know|looking\s+for\s+(?:one|1|two|2)))*$/iu,
  },
  {
    label: "anyone selling ticket",
    regex: new RegExp(
      String.raw`\b(?:if\s+)?(?:anyone|anybody|any1|someone|somebody)\s+(?:is\s+)?selling\s+(?:[\p{L}\p{N}]+\s+){0,8}${ticketTermPattern}\b`,
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
      String.raw`\b(?:does\s+)?(?:anyone|anybody|any1|someone|somebody|any)\s+(?:got|has|have)?\s*(?:a\s+|an\s+|\d+\s+)?(?:spares?|extras?|(?:[\p{L}\p{N}]+\s+){0,3}${ticketTermPattern})\b`,
      "iu",
    ),
  },
  {
    label: "spare ticket going",
    regex: new RegExp(String.raw`\bany\s+spare\s+(?:[\p{L}\p{N}]+\s+){0,3}${ticketTermPattern}\s+going\b`, "iu"),
  },
  {
    label: "ISO ticket",
    regex: new RegExp(String.raw`\biso\s+(?:a\s+|an\s+|\d+\s+)?(?:[\p{L}\p{N}]+\s+){0,3}${ticketTermPattern}\b`, "iu"),
  },
  {
    label: "WTB ticket",
    regex: new RegExp(String.raw`\bwtb\s+(?:a\s+|an\s+|\d+\s+)?(?:[\p{L}\p{N}]+\s+){0,4}${ticketTermPattern}\b`, "iu"),
  },
  {
    label: "in search of ticket",
    regex: new RegExp(
      String.raw`\bin\s+search\s+of\s+(?:a\s+|an\s+|\d+\s+)?(?:[\p{L}\p{N}]+\s+){0,3}${ticketTermPattern}\b`,
      "iu",
    ),
  },
  { label: "quelqu'un vend", regex: /\b(?:quelqu'un|qqn)\s+vend\b/iu },
  { label: "qui vend", regex: /\bqui\s+vend\b/iu },
  {
    label: "looking for ticket",
    regex: new RegExp(String.raw`\blooking\s+for\s+(?:a\s+|\d+\s+)?${ticketTermPattern}\b`, "iu"),
  },
  {
    label: "ticket wanted",
    regex: new RegExp(String.raw`\b${ticketTermPattern}\s+wanted\b`, "iu"),
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
  {
    label: "sell me ticket",
    regex: new RegExp(
      String.raw`\b(?:(?:can|could|will|would)\s+)?(?:anyone|anybody|any1|someone|somebody|some1)\s+(?:please\s+|pls\s+)?sell\s+me\s+(?:a\s+|an\s+|\d+\s+)?(?:[\p{L}\p{N}]+\s+){0,4}${ticketTermPattern}\b`,
      "iu",
    ),
  },
  {
    label: "please sell me ticket",
    regex: new RegExp(
      String.raw`^(?:please\s+|pls\s+)?sell\s+me\s+(?:a\s+|an\s+|\d+\s+)?(?:[\p{L}\p{N}]+\s+){0,4}${ticketTermPattern}\b`,
      "iu",
    ),
  },
];

const TICKET_DEPENDENT_STRONG_BUY_SIGNALS = new Set([
  "anyone selling ticket",
  "ISO ticket",
  "WTB ticket",
  "in search of ticket",
  "looking for ticket",
  "ticket wanted",
]);

const NEGATED_BUYER_INTENT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "looking to buy", regex: /\b(?:not|never|dont|don't|do\s+not)\s+looking\s+to\s+buy\b/iu },
  { label: "trying to find", regex: /\b(?:not|never|dont|don't|do\s+not)\s+trying\s+to\s+find\b/iu },
  { label: "trying to get", regex: /\b(?:not|never|dont|don't|do\s+not)\s+trying\s+to\s+get\b/iu },
  { label: "happy to pay", regex: /\b(?:not|never|dont|don't|do\s+not)\s+happy\s+to\s+pay\b/iu },
  { label: "will pay", regex: /\b(?:not|never|dont|don't|do\s+not)\s+will\s+pay\b/iu },
  { label: "can pay", regex: /\b(?:not|never|dont|don't|do\s+not)\s+can\s+pay\b/iu },
  { label: "buy tickets", regex: /\b(?:not|never|dont|don't|do\s+not)\s+buy(?:ing)?\s+(?:any\s+)?tickets?\b/iu },
];

const NON_MARKETPLACE_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "negated ticket buying",
    regex: /\b(?:not|never|dont|don't|do\s+not)\s+buy(?:ing)?\s+(?:any\s+)?tickets?\b/iu,
  },
  {
    label: "scammer tried to sell me",
    regex: new RegExp(
      String.raw`\b(?:scammer|scammers)\s+(?:is\s+|are\s+|was\s+|were\s+|just\s+)?(?:trying|tryin|tryna|tried)\s+(?:to\s+)?sell\s+me\b`,
      "iu",
    ),
  },
  {
    label: "third party tried to sell me",
    regex: new RegExp(
      String.raw`\b${thirdPartyActorPattern}\s+(?:is\s+|are\s+|was\s+|were\s+|just\s+)?(?:trying|tryin|tryna|tried)\s+(?:to\s+)?sell\s+me\b`,
      "iu",
    ),
  },
  {
    label: "third party selling me",
    regex: new RegExp(
      String.raw`\b${thirdPartyActorPattern}\s+(?:is\s+|are\s+|was\s+|were\s+)?selling\s+me\b`,
      "iu",
    ),
  },
  {
    label: "third party charging for tickets",
    regex: new RegExp(
      String.raw`\b${thirdPartyPluralActorPattern}\s+(?:are\s+|were\s+|be\s+)?(?:charging|asking)\s+(?:me\s+)?${pricePattern}(?:\s+[\p{L}\p{N}]+){0,8}\s+${ticketTermPattern}\b`,
      "iu",
    ),
  },
  {
    label: "general resale question",
    regex: /\b(?:(?:are|is)\s+(?:everyone|people|ppl|they|tickets)\s+(?:selling|charging|asking)|(?:why|whys|why's)\s+(?:(?:am\s+i|i\s+am|i'm)|(?:is\s+)?(?:everyone|people|ppl|they|i|mate|friend|pal|boyfriend|girlfriend|he|she|we)|is\s+(?:my\s+)?(?:mate|friend|pal|boyfriend|girlfriend))\s+(?:selling|charging|asking)|tickets?\s+(?:are|is)\s+selling)\b/iu,
  },
  {
    label: "ticket price complaint",
    regex: new RegExp(
      String.raw`\b(?:selling\s+)?(?:[\p{L}\p{N}]+\s+){0,4}${ticketTermPattern}\b(?:\s+[\p{L}\p{N}]+){0,8}\s+${pricePattern}\s+(?:is|are|feels|seems)\s+(?:crazy|mad|insane|ridiculous|wild|expensive|overpriced|too\s+much|a\s+joke)\b`,
      "iu",
    ),
  },
  {
    label: "not selling complaint",
    regex: /\b(?:i\s+(?:am\s+|'m\s+)?)?not\s+selling\b(?:\s+[\p{L}\p{N}']+){0,12}\s+complain(?:ing)?\b/iu,
  },
  {
    label: "complaint not selling",
    regex: /\bcomplain(?:ing)?\b(?:\s+[\p{L}\p{N}']+){0,12}\s+(?:i\s+(?:am\s+|'m\s+)?)?not\s+selling\b/iu,
  },
];

const ACCOMMODATION_COORDINATION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "accommodation group booking",
    regex: /\b(?:accoms?|accommodation|airbnb|hotel|hostel|villa|apartment|flat|house|place|booking|somewhere\s+to\s+stay|stay|staying)\b(?:\s+[\p{L}\p{N}'£€$]+){0,40}\s+\b(?:guests?|people|ppl|beds?|bedrooms?|double\s+beds?|sleeping\s+arrangements?|booking|secure\s+the\s+booking|per\s+person|pp|pics?)\b/iu,
  },
  {
    label: "lodging sleeping arrangements",
    regex: /\b(?:sleeping\s+arrangements?|double\s+beds?|bedrooms?|beds?)\b(?:\s+[\p{L}\p{N}'£€$]+){0,30}\s+\b(?:sharing|guests?|people|ppl|friend|friends|place|accoms?|accommodation)\b/iu,
  },
  {
    label: "lodging dates and payment",
    regex: /\b(?:dates?\s+are\s+from|from\s+[\p{L}\p{N}]+\s+\d{1,2}\s+(?:to|until|-)\s+[\p{L}\p{N}]+\s+\d{1,2}|june\s+\d{1,2}(?:st|nd|rd|th)?\s+(?:to|until|-)\s+june\s+\d{1,2})\b(?:\s+[\p{L}\p{N}'£€$]+){0,40}\s+\b(?:booking|secure|payments?|per\s+person|pp|guests?|accoms?|accommodation|place)\b/iu,
  },
];

const SUPPORT_CLARIFICATION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "face value clarification",
    regex: /\b(?:what|how|why|does|do|is|are|can|could|should|meaning|mean|means|explain)\b(?:\s+[\p{L}\p{N}'£€$]+){0,8}\s+\b(?:face\s+value|fv)\b/iu,
  },
];

const NON_MARKETPLACE_SUPPORT_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "ticket meaning clarification",
    regex: new RegExp(
      String.raw`\b(?:does\s+anyone\s+know\s+)?(?:what|which|meaning|mean|means|explain)\b(?:\s+[\p{L}\p{N}'£€$]+){0,8}\s+\b${ticketTermPattern}\b(?:\s+[\p{L}\p{N}'£€$]+){0,8}\s+\b(?:mean|means|meaning)\b`,
      "iu",
    ),
  },
];

const REFUTATION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  { label: "not selling", regex: /\b(?:i\s+(?:am\s+|'m\s+)?)?not\s+selling\b/iu },
  { label: "not a sale", regex: /\bnot\s+(?:a\s+)?(?:sale|ticket\s+sale|sales\s+post)\b/iu },
  { label: "complaining", regex: /\b(?:just\s+)?complain(?:ing)?\b/iu },
  { label: "not what I meant", regex: /\bnot\s+what\s+i\s+meant\b/iu },
  { label: "bot misread", regex: /\b(?:wrong|misread|misunderstood)\b/iu },
];

const REFUTATION_EXCLUSION_PATTERNS = [
  /\bnot\s+selling\s+for\s+(?:less|under|below)\b/iu,
  /\bnot\s+selling\s+unless\b/iu,
] as const;

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

const hasSupportQuestionLanguage = (text: string): boolean =>
  /\b(?:what|how|why|where|when|which|does|do|is|are|can|could|should|meaning|mean|means|explain)\b/iu.test(text);

const estimateConfidence = (params: {
  intent: Exclude<TicketMarketplaceIntent, "none">;
  hasConcreteTicketMatch: boolean;
  hasPriceSignal: boolean;
  hasQuestionMark: boolean;
  hasSupportLanguage: boolean;
  hasAvailabilityCue: boolean;
  hasDirectSellVerb: boolean;
  hasStrongSignals: {
    strongBuy: boolean;
    strongSell: boolean;
  };
  buySignalCount: number;
  sellSignalCount: number;
}): MarketplaceConfidence => {
  const {
    intent,
    hasConcreteTicketMatch,
    hasPriceSignal,
    hasQuestionMark,
    hasSupportLanguage,
    hasAvailabilityCue,
    hasDirectSellVerb,
    hasStrongSignals,
    buySignalCount,
    sellSignalCount,
  } = params;

  let score = 0;

  if (intent === "buying") {
    if (hasStrongSignals.strongBuy) score += 3;
    if (hasQuestionMark) score += 2;
    if (buySignalCount > 1) score += 1;
    if (hasConcreteTicketMatch) score += 1;
    if (hasStrongSignals.strongSell) score -= 1;
  }

  if (intent === "selling") {
    if (hasStrongSignals.strongSell) score += 4;
    if (hasPriceSignal) score += 2;
    if (hasAvailabilityCue) score += 1;
    if (hasDirectSellVerb) score += 1;
    if (sellSignalCount > 2) score += 1;
    if (hasStrongSignals.strongBuy) score -= 1;
    if (hasConcreteTicketMatch) score += 1;
  }

  if (hasSupportLanguage) {
    score -= 1;
  }

  if (score <= 2) return "low";
  if (score <= 4) return "medium";
  return "high";
};

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

const NEGATION_TERMS = new Set(["not", "no", "never", "dont", "don't", "cannot", "can't", "wont", "won't"]);

const isNegatedMatch = (tokens: readonly string[], match: TokenMatch): boolean => {
  const windowStart = Math.max(0, match.index - 4);
  const before = tokens.slice(windowStart, match.index);

  if (before.some((token) => NEGATION_TERMS.has(token))) {
    return true;
  }

  return before.some((token, index) => token === "do" && before[index + 1] === "not");
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

export const isTicketMarketplaceRefutation = (text: string): boolean => {
  const normalisedText = normaliseText(text);
  if (!normalisedText) {
    return false;
  }

  if (REFUTATION_EXCLUSION_PATTERNS.some((pattern) => pattern.test(normalisedText))) {
    return false;
  }

  return findPatternMatches(normalisedText, REFUTATION_PATTERNS).length > 0;
};

export const isSpotlightSoldNotice = (text: string): boolean => {
  const normalisedText = normaliseText(text);

  return (
    /^(?:(?:all|now)\s+)?(?:(?:ticket|tickets|tix)\s+)?(?:sold|gone|taken)(?:\s+(?:now|thanks?|thank\s+you|cheers|ticket|tickets|tix))*$/iu.test(
      normalisedText,
    ) ||
    /^(?:no\s+longer|not)\s+available(?:\s+anymore)?$/iu.test(normalisedText)
  );
};

const hasNearbyMatch = (
  leftMatches: readonly TokenMatch[],
  rightMatches: readonly TokenMatch[],
  maxDistance: number,
): boolean =>
  leftMatches.some((left) =>
    rightMatches.some((right) => Math.abs(left.index - right.index) <= maxDistance),
  );

const genericWeakBuyTerms = new Set(["want", "need", "after"]);

const hasConcreteAccessContext = (tokens: readonly string[], match: TokenMatch): boolean => {
  const nextContext = tokens.slice(match.index + 1, match.index + 3);
  if (nextContext.some((token) => NON_TRANSACTION_TICKET_CONTEXT_TERMS.has(token))) {
    return false;
  }

  if (!AMBIGUOUS_ACCESS_TERMS.has(match.token)) {
    return true;
  }

  const windowStart = Math.max(0, match.index - 3);
  const windowEnd = Math.min(tokens.length, match.index + 4);
  const context = tokens.slice(windowStart, windowEnd);

  if (context.some((token) => NON_TICKET_ACCESS_CONTEXT_TERMS.has(token))) {
    return false;
  }

  return context.some((token) => ACCESS_CONTEXT_TERMS.has(token));
};

const getContextualWeakBuyMatches = (
  weakBuyMatches: readonly TokenMatch[],
  ticketMatches: readonly TokenMatch[],
): TokenMatch[] =>
  weakBuyMatches.filter((buyMatch) =>
    ticketMatches.some(
      (ticketMatch) =>
        Math.abs(buyMatch.index - ticketMatch.index) <= 6 &&
        (!genericWeakBuyTerms.has(buyMatch.token) || buyMatch.index <= ticketMatch.index),
    ),
  );

const hasGotTicketsSellingIntent = (
  tokens: readonly string[],
  ticketMatches: readonly TokenMatch[],
  hasAvailabilityCue: boolean,
  pricePresentBeforeIntent: boolean,
): boolean => {
  if (!hasAvailabilityCue && !pricePresentBeforeIntent) {
    return false;
  }

  return ticketMatches.some((match) => tokens[match.index - 2] === "got" && /^\d+$/u.test(tokens[match.index - 1] ?? ""));
};

const unique = (values: readonly string[]): string[] => Array.from(new Set(values));

const emptySignals = (): TicketMarketplaceClassification["matchedSignals"] => ({
  buy: [],
  sell: [],
  dominance: "none",
});

const noTicketMarketplaceIntent = (): TicketMarketplaceClassification => ({
  intent: "none",
  confidence: "low",
  matchedTokens: [],
  matchedSignals: emptySignals(),
  hasPrice: false,
});

const supportClarificationIntent = (matchedTokens: string[]): TicketMarketplaceClassification => ({
  intent: "selling",
  confidence: "low",
  matchedTokens,
  matchedSignals: {
    buy: [],
    sell: matchedTokens,
    dominance: "none",
  },
  hasPrice: false,
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
    return noTicketMarketplaceIntent();
  }

  const supportClarificationSignals = findPatternMatches(normalisedText, SUPPORT_CLARIFICATION_PATTERNS);
  if (supportClarificationSignals.length > 0) {
    return supportClarificationIntent(["face value"]);
  }

  const nonMarketplaceSupportSignals = findPatternMatches(normalisedText, NON_MARKETPLACE_SUPPORT_PATTERNS);
  if (nonMarketplaceSupportSignals.length > 0) {
    return noTicketMarketplaceIntent();
  }

  const tokens = tokenise(normalisedText);
  const accommodationSignals = findPatternMatches(normalisedText, ACCOMMODATION_COORDINATION_PATTERNS);
  if (accommodationSignals.length > 0) {
    return noTicketMarketplaceIntent();
  }

  const ticketMatches = findTermMatches(tokens, TICKET_TERMS);
  const concreteTicketMatches = ticketMatches.filter((match) => hasConcreteAccessContext(tokens, match));
  const nonMarketplaceSignals = findPatternMatches(normalisedText, NON_MARKETPLACE_PATTERNS);
  if (nonMarketplaceSignals.length > 0 && concreteTicketMatches.length > 0) {
    return noTicketMarketplaceIntent();
  }

  const weakBuyMatches = findTermMatches(tokens, WEAK_BUY_TERMS).filter((match) => !isNegatedMatch(tokens, match));
  const weakSellMatches = findTermMatches(tokens, WEAK_SELL_TERMS).filter((match) => !isNegatedMatch(tokens, match));
  const contextualWeakBuyMatches = getContextualWeakBuyMatches(weakBuyMatches, concreteTicketMatches);
  const availabilityMatches = findTermMatches(tokens, AVAILABILITY_CUES);
  const pricePresentBeforeIntent = hasExplicitPrice(normalisedText);
  const hasAvailabilityCue = availabilityMatches.length > 0;
  const hasDirectSellVerb = weakSellMatches.some((match) =>
    ["selling", "sell", "vends", "vend", "vendo", "verkaufe", "te koop"].includes(match.token),
  );

  const buySignals: string[] = [];
  const sellSignals: string[] = [];
  const strongBuySignals = findPatternMatches(normalisedText, STRONG_BUY_PATTERNS).filter(
    (signal) => !TICKET_DEPENDENT_STRONG_BUY_SIGNALS.has(signal) || concreteTicketMatches.length > 0,
  );
  const negatedBuyerIntentSignals = new Set(findPatternMatches(normalisedText, NEGATED_BUYER_INTENT_PATTERNS));
  const buyerIntentSignals = findPatternMatches(normalisedText, BUYER_INTENT_PATTERNS).filter(
    (signal) => !negatedBuyerIntentSignals.has(signal),
  );
  buySignals.push(...strongBuySignals);

  if (contextualWeakBuyMatches.length > 0) {
    buySignals.push(...contextualWeakBuyMatches.map((match) => match.token));
    buySignals.push(...concreteTicketMatches.map((match) => match.token));
  }

  const strongSell =
    hasAnyPhrase(normalisedText, STRONG_SELL_PHRASES, sellSignals) ||
    hasAnyRegex(normalisedText, STRONG_SELL_REGEXES, sellSignals);
  const priceTicketSelling = pricePresentBeforeIntent && concreteTicketMatches.length > 0;

  if (
    buyerIntentSignals.length > 0 &&
    (concreteTicketMatches.length > 0 ||
      strongBuySignals.length > 0 ||
      hasDirectSellVerb ||
      strongSell ||
      pricePresentBeforeIntent)
  ) {
    buySignals.push(...buyerIntentSignals);
  }
  const cantGoSelling = CANT_GO_REGEX.test(normalisedText) && concreteTicketMatches.length > 0;
  const weakSell =
    hasNearbyMatch(weakSellMatches, concreteTicketMatches, 6) &&
    (hasAvailabilityCue || pricePresentBeforeIntent || hasDirectSellVerb);
  const gotTicketsSelling = hasGotTicketsSellingIntent(
    tokens,
    concreteTicketMatches,
    hasAvailabilityCue,
    pricePresentBeforeIntent,
  );

  if (strongSell || cantGoSelling || weakSell || gotTicketsSelling || priceTicketSelling) {
    if (cantGoSelling) {
      sellSignals.push("can't go");
      sellSignals.push(...concreteTicketMatches.map((match) => match.token));
    }

    if (weakSell) {
      sellSignals.push(...weakSellMatches.map((match) => match.token));
      sellSignals.push(...concreteTicketMatches.map((match) => match.token));
      sellSignals.push(...availabilityMatches.map((match) => match.token));
    }

    if (gotTicketsSelling) {
      sellSignals.push("got N tickets");
    }

    if (priceTicketSelling) {
      sellSignals.push("price");
      sellSignals.push(...concreteTicketMatches.map((match) => match.token));
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
      hasPleaseTicketContext(normalisedText, concreteTicketMatches));

  if (hasBuySignals && (!hasSellSignals || buyDominates)) {
    const matchedSignals = {
      buy: unique(buySignals),
      sell: unique(sellSignals),
      dominance: hasSellSignals ? ("buy" as const) : ("none" as const),
    };
    return {
      intent: "buying",
      confidence: estimateConfidence({
        intent: "buying",
        hasConcreteTicketMatch: concreteTicketMatches.length > 0,
        hasPriceSignal: hasValidPrice(normalisedText, "buying"),
        hasQuestionMark: rawEndsWithQuestionMark,
        hasSupportLanguage: hasSupportQuestionLanguage(normalisedText),
        hasAvailabilityCue,
        hasDirectSellVerb,
        hasStrongSignals: {
          strongBuy: strongBuySignals.length > 0,
          strongSell,
        },
        buySignalCount: buySignals.length,
        sellSignalCount: sellSignals.length,
      }),
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
      confidence: estimateConfidence({
        intent: "selling",
        hasConcreteTicketMatch: concreteTicketMatches.length > 0,
        hasPriceSignal: hasValidPrice(normalisedText, "selling"),
        hasQuestionMark: rawEndsWithQuestionMark,
        hasSupportLanguage: hasSupportQuestionLanguage(normalisedText),
        hasAvailabilityCue,
        hasDirectSellVerb,
        hasStrongSignals: {
          strongBuy: false,
          strongSell:
            strongSell ||
            cantGoSelling ||
            weakSell ||
            gotTicketsSelling ||
            priceTicketSelling,
        },
        buySignalCount: buySignals.length,
        sellSignalCount: sellSignals.length,
      }),
      matchedTokens: unique([...matchedSignals.sell, ...matchedSignals.buy]),
      matchedSignals,
      hasPrice: hasValidPrice(normalisedText, "selling"),
    };
  }

  return {
    ...noTicketMarketplaceIntent(),
  };
};
