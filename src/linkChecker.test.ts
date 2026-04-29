import { getDomain } from "tldts";
import { describe, expect, it } from "vitest";

import { containsDisallowedUrl, extractUrls, isAllowed } from "./linkChecker.js";

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
    expect(containsDisallowedUrl("join https://chat.whatsapp.com/abc123")).toEqual({
      found: true,
      url: "https://chat.whatsapp.com/abc123",
      reason: "whatsapp invite link",
    });
  });

  it("distinguishes allowed social profiles from blocked content URLs", () => {
    expect(isAllowed("https://instagram.com/outofofficecollective")).toBe(true);
    expect(isAllowed("https://instagram.com/p/abc123")).toBe(false);
    expect(isAllowed("https://tiktok.com/@outofofficecollective")).toBe(true);
    expect(isAllowed("https://tiktok.com/@outofofficecollective/video/123")).toBe(false);
    expect(isAllowed("https://music.youtube.com/watch?v=123")).toBe(true);
    expect(isAllowed("https://youtu.be/abc123")).toBe(false);
  });

  it("allows common social profile URL shapes with and without www or @", () => {
    expect(isAllowed("https://www.instagram.com/milkandhenny/")).toBe(true);
    expect(isAllowed("https://www.tiktok.com/@milkandhenny")).toBe(true);
    expect(isAllowed("https://x.com/milkandhenny")).toBe(true);
    expect(isAllowed("https://x.com/@milkandhenny")).toBe(true);
    expect(isAllowed("https://twitter.com/milkandhenny")).toBe(true);
    expect(isAllowed("https://twitter.com/@milkandhenny")).toBe(true);
  });

  it("does not treat dotted social handles as bare URLs", () => {
    expect(extractUrls("itss.davinaa ty sis")).toEqual([]);
    expect(extractUrls("@/itss.davinaa love")).toEqual([]);
    expect(containsDisallowedUrl("itss.davinaa ty sis")).toEqual({ found: false });
    expect(containsDisallowedUrl("@/itss.davinaa love")).toEqual({ found: false });
  });

  it("still treats real bare domains as URLs", () => {
    expect(containsDisallowedUrl("google.com")).toEqual({
      found: true,
      url: "google.com",
      reason: "bare profile handle or URL",
    });
    expect(containsDisallowedUrl("ra.co/events/1")).toEqual({
      found: true,
      url: "ra.co/events/1",
      reason: "ticket platform",
    });
    expect(containsDisallowedUrl("example.co.uk/thing")).toEqual({
      found: true,
      url: "example.co.uk/thing",
      reason: "not in allowlist",
    });
  });

  it("blocks explicit links even when the suffix is not a known public suffix", () => {
    expect(containsDisallowedUrl("https://itss.davinaa")).toEqual({
      found: true,
      url: "https://itss.davinaa",
      reason: "not in allowlist",
    });
    expect(containsDisallowedUrl("www.itss.davinaa")).toEqual({
      found: true,
      url: "www.itss.davinaa",
      reason: "not in allowlist",
    });
  });

  it("documents profile and redirect edge cases", () => {
    expect(containsDisallowedUrl("@milkandhenny.com")).toEqual({ found: false });
    expect(containsDisallowedUrl("@/milkandhenny.com")).toEqual({ found: false });
    expect(containsDisallowedUrl("milkandhenny.com")).toEqual({
      found: true,
      url: "milkandhenny.com",
      reason: "bare profile handle or URL",
    });
    expect(containsDisallowedUrl("https://instagram.com/milkandhenny")).toEqual({ found: false });
    expect(containsDisallowedUrl("https://instagram.com/reel/abc123")).toEqual({
      found: true,
      url: "https://instagram.com/reel/abc123",
      reason: "not in allowlist",
    });
    expect(containsDisallowedUrl("https://l.instagram.com/?u=https%3A%2F%2Fexample.com")).toEqual({
      found: true,
      url: "https://l.instagram.com/?u=https%3A%2F%2Fexample.com",
      reason: "not in allowlist",
    });
    expect(containsDisallowedUrl("https://vm.tiktok.com/example")).toEqual({
      found: true,
      url: "https://vm.tiktok.com/example",
      reason: "url shortener",
    });
  });
});
