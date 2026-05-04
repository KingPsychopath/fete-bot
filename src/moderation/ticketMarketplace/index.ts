import type { Config } from "../../config.js";
import { classify, type TicketMarketplaceClassification } from "./classifier.js";

export type TicketMarketplaceAction =
  | "allow"
  | "redirect_buying"
  | "redirect_selling"
  | "require_price";

export type TicketMarketplaceDecision = TicketMarketplaceClassification & {
  action: TicketMarketplaceAction;
  reason: string | null;
};

const SUPPORT_EXCEPTION_TEXT_PATTERNS = [
  /\bwhat\s+does\b/i,
  /\bwhat\s+is\b/i,
  /\bhow\s+(?:do|can|is|are|much|easy)\b/i,
  /\bcan\s+(?:someone|i)\b/i,
  /\bwhy\b/i,
  /\bmeaning\b/i,
  /\bexplain\b/i,
  /\bface\s+value\b/i,
  /\bfv\b/i,
  /\bshotgun\b/i,
  /\bresell\b/i,
  /\bbook(?:ing)?\b.*\banother\b/i,
] as const;

const SUPPORT_EXCEPTION_DOMAIN_PATTERNS = [
  /\bticket\s+(?:marketplace|rules?|policy|app|platform|resale|resell)\b/i,
  /\bcan\s+you\s+?please\b/i,
] as const;

const isSupportException = (text: string): boolean => {
  const normalisedText = text.toLowerCase().replace(/[^\p{L}\p{N}'\s]/gu, " ");
  if (normalisedText.length < 6) {
    return false;
  }

  const hasSupportPattern = SUPPORT_EXCEPTION_TEXT_PATTERNS.some((pattern) => pattern.test(normalisedText));
  const hasDomainPattern = SUPPORT_EXCEPTION_DOMAIN_PATTERNS.some((pattern) => pattern.test(normalisedText));
  const hasQuestionWord = /\b(?:what|how|why|where|when)\b/i.test(normalisedText);

  return (hasSupportPattern || hasDomainPattern) && hasQuestionWord;
};

export const getTicketMarketplaceDecision = (
  config: Config,
  groupJid: string,
  text: string,
): TicketMarketplaceDecision => {
  const classification = classify(text);
  const isSupport = isSupportException(text);
  const marketplaceEnabled =
    config.ticketMarketplaceManagement && config.ticketMarketplaceGroupJids.length > 0;

  if (!marketplaceEnabled || classification.intent === "none") {
    return { ...classification, action: "allow", reason: null };
  }

  const isMarketplaceGroup = config.ticketMarketplaceGroupJids.includes(groupJid);

  if (!isMarketplaceGroup) {
    if (
      isSupport &&
      (classification.confidence === "low" || classification.confidence === "medium") &&
      (classification.intent === "selling" || classification.intent === "buying")
    ) {
      return { ...classification, action: "allow", reason: "ticket_marketplace_support_exception" };
    }

    return {
      ...classification,
      action: classification.intent === "buying" ? "redirect_buying" : "redirect_selling",
      reason: `ticket_marketplace_redirect_${classification.intent}`,
    };
  }

  if (classification.intent === "selling" && !classification.hasPrice) {
    if (
      isSupport &&
      (classification.confidence === "low" || classification.confidence === "medium")
    ) {
      return { ...classification, action: "allow", reason: "ticket_marketplace_support_exception" };
    }

    return {
      ...classification,
      action: "require_price",
      reason: "ticket_marketplace_missing_price",
    };
  }

  return { ...classification, action: "allow", reason: "ticket_marketplace_allowed" };
};
