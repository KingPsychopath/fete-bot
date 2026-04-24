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

export const getTicketMarketplaceDecision = (
  config: Config,
  groupJid: string,
  text: string,
): TicketMarketplaceDecision => {
  const classification = classify(text);
  const marketplaceEnabled =
    config.ticketMarketplaceManagement && config.ticketMarketplaceGroupJids.length > 0;

  if (!marketplaceEnabled || classification.intent === "none") {
    return { ...classification, action: "allow", reason: null };
  }

  const isMarketplaceGroup = config.ticketMarketplaceGroupJids.includes(groupJid);

  if (!isMarketplaceGroup) {
    return {
      ...classification,
      action: classification.intent === "buying" ? "redirect_buying" : "redirect_selling",
      reason: `ticket_marketplace_redirect_${classification.intent}`,
    };
  }

  if (classification.intent === "selling" && !classification.hasPrice) {
    return {
      ...classification,
      action: "require_price",
      reason: "ticket_marketplace_missing_price",
    };
  }

  return { ...classification, action: "allow", reason: "ticket_marketplace_allowed" };
};
