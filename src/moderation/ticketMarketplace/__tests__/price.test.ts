import { describe, expect, it } from "vitest";

import { hasValidPrice } from "../price.js";
import { ACCEPTED_PRICES, REJECTED_PRICES } from "./fixtures.js";

describe("price - accepted", () => {
  it.each(ACCEPTED_PRICES)("%s", (text) => {
    expect(hasValidPrice(text, "selling")).toBe(true);
  });
});

describe("price - rejected", () => {
  it.each(REJECTED_PRICES)("%s", (text) => {
    expect(hasValidPrice(text, "selling")).toBe(false);
  });
});

describe("price - context dependent", () => {
  it("accepts lazy euro and bare numbers only for confirmed selling intent", () => {
    expect(hasValidPrice("50e", "selling")).toBe(true);
    expect(hasValidPrice("50e", "buying")).toBe(false);
    expect(hasValidPrice("Selling 2 Sundays, 80 each", "selling")).toBe(true);
    expect(hasValidPrice("80 each", "buying")).toBe(false);
  });
});
