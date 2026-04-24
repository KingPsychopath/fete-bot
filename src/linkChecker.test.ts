import { getDomain } from "tldts";
import { describe, expect, it } from "vitest";

import { containsDisallowedUrl, isAllowed } from "./linkChecker.js";

describe("linkChecker accommodation links", () => {
  it("allows distinctive accommodation brands across TLDs", () => {
    expect(isAllowed("https://airbnb.com/rooms/123")).toBe(true);
    expect(isAllowed("https://airbnb.co.uk/rooms/123")).toBe(true);
    expect(isAllowed("https://airbnb.fr/rooms/123")).toBe(true);
    expect(isAllowed("https://booking.com/hotel/fr/example.html")).toBe(true);
    expect(isAllowed("https://www.booking.com/accommodation/index.fr.html")).toBe(true);
    expect(isAllowed("https://hostelworld.fr/hosteldetails.php/example")).toBe(true);
    expect(isAllowed("https://trivago.fr/fr/srl")).toBe(true);
    expect(isAllowed("https://expedia.fr/Hotel-Search")).toBe(true);
  });

  it("allows exact accommodation domains for generic brands", () => {
    expect(getDomain("fr.trip.com")).toBe("trip.com");

    expect(isAllowed("https://trip.com/hotels/")).toBe(true);
    expect(isAllowed("https://fr.trip.com/hotels/")).toBe(true);
    expect(isAllowed("https://trip.fr/hotels/")).toBe(true);
    expect(isAllowed("https://hotels.com/ho123456")).toBe(true);
  });

  it("blocks accommodation lookalikes and generic false positives", () => {
    expect(isAllowed("https://booking.evil.com")).toBe(false);
    expect(isAllowed("https://airbnb.evil.com")).toBe(false);
    expect(isAllowed("https://trip.com.evil.net")).toBe(false);
    expect(isAllowed("https://mytrip.fr")).toBe(false);
    expect(isAllowed("https://roadtrip.com")).toBe(false);
    expect(isAllowed("https://cheaphotels.net")).toBe(false);
  });

  it("keeps existing blocked link behavior", () => {
    expect(containsDisallowedUrl("visit https://ra.co/events/1")).toEqual({
      found: true,
      url: "https://ra.co/events/1",
      reason: "ticket platform",
    });
    expect(containsDisallowedUrl("visit https://bit.ly/example")).toEqual({
      found: true,
      url: "https://bit.ly/example",
      reason: "url shortener",
    });
    expect(containsDisallowedUrl("watch https://youtube.com/watch?v=123")).toEqual({
      found: true,
      url: "https://youtube.com/watch?v=123",
      reason: "youtube (music.youtube.com only)",
    });
  });
});
