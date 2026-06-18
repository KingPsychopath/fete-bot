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
  url: "/exchange/evt_fb92305ee56b7b95",
} satisfies WebsiteTicketExchangeListing;

describe("website Ticket Exchange announcements", () => {
  it("formats selling copy with a clear contact action", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      listing,
    );

    expect(message).toContain("🎟️ Ticket listed");
    expect(message).toContain("Sunday 21st · 18:00");
    expect(message).toContain("Qty x1 · £35");
    expect(message).toContain("Visible until 02 Jun, 12:49");
    expect(message).toContain("Note: need garn");
    expect(message).toContain("Interested? Use the link to reply.");
    expect(message).toContain("https://fete.outofofficecollective.co.uk/exchange/evt_fb92305ee56b7b95");
    expect(message).toContain("Please check details before paying.");
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

    expect(message).toContain("🎟️ Ticket request");
    expect(message).toContain("Qty x1 · Budget £40");
    expect(message).toContain("Got one? Use the link to reply.");
  });

  it("removes notes with obvious profanity", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      {
        ...listing,
        note: "need this badly, no shit offers",
      },
    );

    expect(message).toContain("Note: [removed for language]");
    expect(message).not.toContain("shit");
  });

  it("removes notes with creative spacing and hate language", () => {
    const message = buildWebsiteTicketExchangeAnnouncement(
      "https://fete.outofofficecollective.co.uk",
      {
        ...listing,
        note: "no f u c k i n g timewasters, heil hitler",
      },
    );

    expect(message).toContain("Note: [removed for language]");
    expect(message).not.toContain("heil");
  });
});
