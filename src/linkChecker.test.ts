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

  it("allows Pinterest and common clothing shopping links", () => {
    expect(isAllowed("https://pinterest.com/pin/123")).toBe(true);
    expect(isAllowed("https://www.pinterest.co.uk/pin/123")).toBe(true);
    expect(isAllowed("https://vinted.co.uk/items/123")).toBe(true);
    expect(isAllowed("https://depop.com/products/example")).toBe(true);
    expect(isAllowed("https://www.ebay.co.uk/itm/123")).toBe(true);
    expect(isAllowed("https://etsy.com/listing/123/example")).toBe(true);
    expect(isAllowed("https://www.etsy.co.uk/listing/123/example")).toBe(true);
    expect(isAllowed("https://amazon.fr/dp/example")).toBe(true);
    expect(isAllowed("https://asos.com/women/dresses")).toBe(true);
    expect(isAllowed("https://www.zara.com/uk/en/example-p123.html")).toBe(true);
    expect(isAllowed("https://www2.hm.com/en_gb/productpage.123.html")).toBe(true);
    expect(isAllowed("https://endclothing.com/gb/example.html")).toBe(true);
    expect(isAllowed("https://fashionnova.com/products/example")).toBe(true);
    expect(isAllowed("https://boohoo.com/product/example")).toBe(true);
    expect(isAllowed("https://boohooman.com/mens/example")).toBe(true);
    expect(isAllowed("https://shein.co.uk/example-p-123.html")).toBe(true);
    expect(isAllowed("https://prettylittlething.com/example.html")).toBe(true);
    expect(isAllowed("https://missguided.co.uk/example")).toBe(true);
    expect(isAllowed("https://nastygal.com/product/example")).toBe(true);
    expect(isAllowed("https://ohpolly.com/products/example")).toBe(true);
    expect(isAllowed("https://meshki.co.uk/products/example")).toBe(true);
    expect(isAllowed("https://shopcider.com/product/detail")).toBe(true);
    expect(isAllowed("https://motelrocks.com/products/example")).toBe(true);
    expect(isAllowed("https://houseofcb.com/example.html")).toBe(true);
    expect(isAllowed("https://skims.com/products/example")).toBe(true);
    expect(isAllowed("https://princesspolly.com/products/example")).toBe(true);
    expect(isAllowed("https://revolve.com/example/dp/example")).toBe(true);
    expect(isAllowed("https://freepeople.com/shop/example")).toBe(true);
    expect(isAllowed("https://abercrombie.com/shop/uk/p/example")).toBe(true);
    expect(isAllowed("https://hollisterco.com/shop/uk/p/example")).toBe(true);
    expect(isAllowed("https://garageclothing.com/products/example")).toBe(true);
    expect(isAllowed("https://brandymelville.com/products/example")).toBe(true);
    expect(isAllowed("https://weekday.com/en_gbp/p/example")).toBe(true);
    expect(isAllowed("https://newlook.com/uk/womens/example")).toBe(true);
    expect(isAllowed("https://riverisland.com/p/example")).toBe(true);
    expect(isAllowed("https://next.co.uk/style/example")).toBe(true);
    expect(isAllowed("https://marksandspencer.com/example/p/example")).toBe(true);
    expect(isAllowed("https://primark.com/en-gb/p/example")).toBe(true);
    expect(isAllowed("https://tkmaxx.com/uk/en/women/example")).toBe(true);
    expect(isAllowed("https://lululemon.co.uk/p/example")).toBe(true);
    expect(isAllowed("https://aloyoga.com/products/example")).toBe(true);
    expect(isAllowed("https://gymshark.com/products/example")).toBe(true);
    expect(isAllowed("https://stockx.com/example")).toBe(true);
    expect(isAllowed("https://goat.com/sneakers/example")).toBe(true);
    expect(isAllowed("https://vestiairecollective.com/women-clothing/example")).toBe(true);
    expect(isAllowed("https://therealreal.com/products/example")).toBe(true);
    expect(containsDisallowedUrl("fit inspo https://pinterest.com/pin/123")).toEqual({ found: false });
    expect(containsDisallowedUrl("selling on https://vinted.co.uk/items/123")).toEqual({ found: false });
  });

  it("blocks shopping lookalikes", () => {
    expect(isAllowed("https://amazon.evil.com/dp/example")).toBe(false);
    expect(isAllowed("https://depop.evil.com/products/example")).toBe(false);
    expect(isAllowed("https://ebay-listing.example.com/itm/123")).toBe(false);
    expect(isAllowed("https://mypinterest.co.uk/pin/123")).toBe(false);
    expect(isAllowed("https://endclothing.com.evil.net/gb/example.html")).toBe(false);
    expect(isAllowed("https://shein.evil.com/product/example")).toBe(false);
    expect(isAllowed("https://fashionnova.example.com/products/example")).toBe(false);
    expect(isAllowed("https://prettylittlething.com.evil.net/example.html")).toBe(false);
  });

  it("allows Apple Maps and Google Maps links without allowing all Google links", () => {
    expect(isAllowed("https://maps.apple.com/?q=Venue")).toBe(true);
    expect(isAllowed("https://www.google.com/maps/place/Venue")).toBe(true);
    expect(isAllowed("https://google.com/maps/search/?api=1&query=Venue")).toBe(true);
    expect(isAllowed("https://maps.google.com/?q=Venue")).toBe(true);
    expect(isAllowed("https://maps.google.co.uk/maps?q=Venue")).toBe(true);
    expect(isAllowed("https://maps.app.goo.gl/example")).toBe(true);
    expect(containsDisallowedUrl("meet here https://maps.apple.com/?q=Venue")).toEqual({ found: false });
    expect(containsDisallowedUrl("pin https://www.google.com/maps/place/Venue")).toEqual({ found: false });

    expect(isAllowed("https://google.com/search?q=Venue")).toBe(false);
    expect(isAllowed("https://docs.google.com/document/d/example")).toBe(false);
    expect(isAllowed("https://maps.google.evil.com/?q=Venue")).toBe(false);
  });

  it("allows reservations, rides, transit, and Paris practical links", () => {
    expect(isAllowed("https://opentable.com/r/example-paris")).toBe(true);
    expect(isAllowed("https://resy.com/cities/paris/venues/example")).toBe(true);
    expect(isAllowed("https://sevenrooms.com/reservations/example")).toBe(true);
    expect(isAllowed("https://thefork.com/restaurant/example-r123")).toBe(true);
    expect(isAllowed("https://zenchef.com/restaurants/example")).toBe(true);
    expect(isAllowed("https://citymapper.com/directions")).toBe(true);
    expect(isAllowed("https://m.uber.com/ul/")).toBe(true);
    expect(isAllowed("https://bolt.eu/en/")).toBe(true);
    expect(isAllowed("https://ratp.fr/itineraires")).toBe(true);
    expect(isAllowed("https://iledefrance-mobilites.fr/itineraire")).toBe(true);
    expect(isAllowed("https://sncf-connect.com/app/en-en/")).toBe(true);
    expect(isAllowed("https://trainline.com/book/results")).toBe(true);
    expect(isAllowed("https://eurostar.com/uk-en/train/france/paris")).toBe(true);
    expect(isAllowed("https://g7.fr/en/")).toBe(true);
    expect(containsDisallowedUrl("booked https://resy.com/cities/paris/venues/example")).toEqual({ found: false });
    expect(containsDisallowedUrl("route https://citymapper.com/directions")).toEqual({ found: false });

    expect(isAllowed("https://resy.evil.com/cities/paris")).toBe(false);
    expect(isAllowed("https://uber.evil.com/ul/")).toBe(false);
    expect(isAllowed("https://ratp.fr.evil.net/itineraires")).toBe(false);
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
