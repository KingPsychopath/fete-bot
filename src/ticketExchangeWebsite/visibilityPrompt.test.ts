import { describe, expect, it } from "vitest";

import {
  buildSpotlightWebsitePromptText,
  buildTicketExchangeRedirectText,
  buildTicketExchangeUrl,
} from "./visibilityPrompt.js";

describe("Ticket Exchange visibility prompts", () => {
  it("builds the public Ticket Exchange URL", () => {
    expect(buildTicketExchangeUrl("https://fete.outofofficecollective.co.uk/")).toBe(
      "https://fete.outofofficecollective.co.uk/tickets",
    );
  });

  it("builds the spotlight DM prompt", () => {
    const text = buildSpotlightWebsitePromptText("https://fete.outofofficecollective.co.uk");

    expect(text).toContain("we've queued your ticket post for extra visibility");
    expect(text).toContain("Fete Finder Ticket Exchange");
    expect(text).toContain("https://fete.outofofficecollective.co.uk/tickets");
  });

  it("builds buying and selling redirect copy", () => {
    expect(
      buildTicketExchangeRedirectText({
        action: "redirect_buying",
        mentionLabel: "@447700900000",
        marketplaceName: "FDLM Ticket Marketplace",
        baseUrl: "https://fete.outofofficecollective.co.uk",
      }),
    ).toContain("Please post in FDLM Ticket Marketplace, or use Fete Finder Ticket Exchange");

    expect(
      buildTicketExchangeRedirectText({
        action: "redirect_selling",
        mentionLabel: "@447700900000",
        marketplaceName: "FDLM Ticket Marketplace",
        baseUrl: "https://fete.outofofficecollective.co.uk",
      }),
    ).toContain("For better visibility, you can also list on Fete Finder Ticket Exchange");
  });
});
