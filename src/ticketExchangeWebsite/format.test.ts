import { describe, expect, it } from "vitest";

import type { WebsiteTicketExchangeListing } from "./client.js";
import { buildWebsiteTicketExchangeAnnouncement } from "./format.js";

const listing = {
  id: "listing_1",
  eventKey: "event_1",
  eventSlug: "sixtion-welcome-2-paris",
  eventName: "SIXTION - Welcome 2 Paris",
  eventDateLabel: "Sunday 21st · 18:00",
  listingType: "selling",
  quantityLabel: "1",
  priceLabel: "£35",
  note: "need garn",
  expiresAt: "2026-06-02T11:49:00.000Z",
  createdAt: "2026-06-02T08:50:00.000Z",
  url: "/tickets/evt_fb92305ee56b7b95",
} satisfies WebsiteTicketExchangeListing;

describe("website Ticket Exchange announcements", () => {
  it("formats selling copy with a clear contact action", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      listing,
    );

    expect(message).toContain("🎟️ Selling on Ticket Exchange");
    expect(message).toContain("Sunday 21st · 18:00");
    expect(message).toContain("Qty x1 · £35");
    expect(message).toContain("Visible until today, 12:49");
    expect(message).toContain("Note: need garn");
    expect(message).toContain("Interested? Open the link to contact them.");
    expect(message).toContain("https://fete.outofofficecollective.co.uk/tickets/evt_fb92305ee56b7b95");
    expect(message).toContain("OOOC only connects people - please check details before paying.");
  });

  it("formats looking copy with budget language", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      {
        ...listing,
        listingType: "looking",
        priceLabel: "£40",
        note: "",
      },
    );

    expect(message).toContain("🎟️ Looking for tickets on Ticket Exchange");
    expect(message).toContain("Qty x1 · Budget £40");
    expect(message).toContain("Got one? Open the link to contact them.");
  });

  it("masks obvious profanity in notes", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      {
        ...listing,
        note: "need this badly, no shit offers",
      },
    );

    expect(message).toContain("Note: need this badly, no **** offers");
    expect(message).not.toContain("shit");
  });
});
