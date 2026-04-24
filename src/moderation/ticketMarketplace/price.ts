export type PriceIntent = "none" | "buying" | "selling";

const DECIMAL_NUMBER = String.raw`\d+(?:[.,]\d{1,2})?`;
const PRICE_RANGE = String.raw`${DECIMAL_NUMBER}(?:\s*[-–]\s*${DECIMAL_NUMBER})?`;

const SYMBOL_PRICE_REGEX = new RegExp(
  String.raw`(?:[£€$]\s*${PRICE_RANGE}|${PRICE_RANGE}\s*[£€$])`,
  "iu",
);

const CODE_PRICE_REGEX = new RegExp(
  String.raw`(?:\b(?:gbp|eur|usd)\s*${PRICE_RANGE}\b|\b${PRICE_RANGE}\s*(?:gbp|eur|usd)\b)`,
  "iu",
);

const WORD_PRICE_REGEX = new RegExp(
  String.raw`\b${PRICE_RANGE}\s*(?:quid|pounds?|euros?|dollars?)\b`,
  "iu",
);

const KEYWORD_PRICE_REGEX = /\b(?:face\s+value|fv|free|gratuit|gratis)\b/iu;
const LAZY_EURO_REGEX = new RegExp(String.raw`\b${PRICE_RANGE}\s*e\b`, "iu");
const BARE_NUMBER_REGEX = /\b\d+(?:[.,]\d{1,2})?\b/gu;
const MISSING_PRICE_ONLY_REGEX = /\b(?:ono|or\s+best\s+offer|dm\s+for\s+price|offers?(?:\s+welcome)?)\b/iu;

export const hasExplicitPrice = (text: string): boolean =>
  SYMBOL_PRICE_REGEX.test(text) ||
  CODE_PRICE_REGEX.test(text) ||
  WORD_PRICE_REGEX.test(text) ||
  KEYWORD_PRICE_REGEX.test(text);

export const hasMissingPriceOnlyCue = (text: string): boolean => MISSING_PRICE_ONLY_REGEX.test(text);

export const hasValidPrice = (text: string, intent: PriceIntent): boolean => {
  if (hasExplicitPrice(text)) {
    return true;
  }

  if (intent !== "selling" || hasMissingPriceOnlyCue(text)) {
    return false;
  }

  if (LAZY_EURO_REGEX.test(text)) {
    return true;
  }

  if (text.length >= 200) {
    return false;
  }

  for (const match of text.matchAll(BARE_NUMBER_REGEX)) {
    const value = Number((match[0] ?? "").replace(",", "."));
    if (Number.isFinite(value) && value >= 10) {
      return true;
    }
  }

  return false;
};
