import type { Config } from "../../config.js";
import { getTicketMarketplaceDecision } from "./index.js";

const formatList = (values: readonly string[]): string => values.length > 0 ? values.join(", ") : "none";

export const buildTicketMarketplaceExplainText = (
  config: Config,
  groupJid: string,
  text: string,
): string => {
  const decision = getTicketMarketplaceDecision(config, groupJid, text);

  return `Ticket marketplace explanation

Group: ${groupJid}
Action: ${decision.action}
Reason: ${decision.reason ?? "none"}
Intent: ${decision.intent}
Confidence: ${decision.confidence}
Has price: ${decision.hasPrice ? "yes" : "no"}
Matched tokens: ${formatList(decision.matchedTokens)}
Buy signals: ${formatList(decision.matchedSignals.buy)}
Sell signals: ${formatList(decision.matchedSignals.sell)}
Dominance: ${decision.matchedSignals.dominance}

Text: "${text.trim()}"`;
};
