import { describe, expect, it } from "vitest";

import { classify } from "../classifier.js";
import {
  CONFUSIONS,
  KNOWN_FALSE_NEGATIVES,
  KNOWN_FALSE_POSITIVES,
  TRUE_NEGATIVES,
  TRUE_POSITIVES_BUYING,
  TRUE_POSITIVES_SELLING,
} from "./fixtures.js";

describe("classifier - true positives buying", () => {
  it.each(TRUE_POSITIVES_BUYING)("%s", (text) => {
    expect(classify(text).intent).toBe("buying");
  });
});

describe("classifier - true positives selling", () => {
  it.each(TRUE_POSITIVES_SELLING)("%s", (text) => {
    expect(classify(text).intent).toBe("selling");
  });
});

describe("classifier - true negatives", () => {
  it.each(TRUE_NEGATIVES)("%s", (text) => {
    expect(classify(text).intent).toBe("none");
  });
});

describe("classifier - known false positives", () => {
  it("starts empty on this tuning pass", () => {
    expect(KNOWN_FALSE_POSITIVES).toHaveLength(0);
  });

  it.each([...KNOWN_FALSE_POSITIVES])("%s", (text) => {
    expect(classify(text).intent).toBe("none");
  });
});

describe("classifier - known false negatives", () => {
  it("starts empty on this tuning pass", () => {
    expect(KNOWN_FALSE_NEGATIVES).toHaveLength(0);
  });

  it.each([...KNOWN_FALSE_NEGATIVES])("%s", (text) => {
    expect(classify(text).intent).not.toBe("none");
  });
});

describe("classifier - confusions", () => {
  it.each(CONFUSIONS)("$text -> $expected because $reason", ({ text, expected }) => {
    expect(classify(text).intent).toBe(expected);
  });
});

describe("classifier - buying dominance", () => {
  it.each([
    "if anyone is selling lmk",
    "anyone selling? looking for one",
    "please let me know if someone is selling",
  ])("%s -> buying", (text) => {
    const result = classify(text);
    expect(result.intent).toBe("buying");
    expect(result.matchedSignals.dominance).toBe("buy");
  });
});

describe("classifier - structural behavior", () => {
  it("is invariant to case, whitespace, punctuation, and apostrophe variants", () => {
    expect(classify("Anyone selling?").intent).toBe("buying");
    expect(classify("anyone selling?").intent).toBe("buying");
    expect(classify("ANYONE SELLING?").intent).toBe("buying");
    expect(classify("  Anyone   selling?  ").intent).toBe("buying");
    expect(classify("can't go, Sunday ticket").intent).toBe("selling");
    expect(classify("can’t go, Sunday ticket").intent).toBe("selling");
  });

  it("tolerates punctuation and emoji", () => {
    expect(classify("Anyone selling??? 🙏").intent).toBe("buying");
    expect(classify("Selling 🎟️🎟️ £80 each").intent).toBe("selling");
  });

  it("handles length extremes", () => {
    expect(classify("").intent).toBe("none");
    expect(classify("selling").intent).toBe("none");
    expect(classify(`${"x ".repeat(1000)} selling 2 sunday tickets £80 ${"x ".repeat(1000)}`).intent).toBe("selling");
  });

  it("handles mixed-language messages", () => {
    expect(classify("cherche ticket for Sunday please").intent).toBe("buying");
  });

  it("documents simple negation policy", () => {
    expect(classify("I am not selling anything").intent).toBe("none");
  });

  it("always returns the full output shape", () => {
    const result = classify("Anyone selling?");
    expect(result).toHaveProperty("intent");
    expect(result).toHaveProperty("matchedTokens");
    expect(result).toHaveProperty("matchedSignals");
    expect(result).toHaveProperty("hasPrice");
    expect(Array.isArray(result.matchedSignals.buy)).toBe(true);
    expect(Array.isArray(result.matchedSignals.sell)).toBe(true);
    expect(["buy", "sell", "none"]).toContain(result.matchedSignals.dominance);
  });

  it("is deterministic", () => {
    const first = classify("Selling 2 Sunday tickets £80 each");
    for (let index = 0; index < 1_000; index += 1) {
      expect(classify("Selling 2 Sunday tickets £80 each")).toEqual(first);
    }
  });

  it("classifies 1000 representative messages under the soft performance budget", () => {
    const start = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      classify(index % 2 === 0 ? "Selling 2 Sunday tickets £80 each" : "if anyone is selling please lmk");
    }
    expect(performance.now() - start).toBeLessThan(100);
  });
});
