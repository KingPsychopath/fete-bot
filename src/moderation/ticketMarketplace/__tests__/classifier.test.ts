import { describe, expect, it } from "vitest";

import { classify } from "../classifier.js";
import {
  TRUE_NEGATIVES,
  TRUE_POSITIVES_BUYING,
  TRUE_POSITIVES_SELLING_NO_PRICE,
  TRUE_POSITIVES_SELLING_WITH_PRICE,
} from "./fixtures.js";

describe("classifier - true positives buying", () => {
  it.each(TRUE_POSITIVES_BUYING)("%s", (text) => {
    expect(classify(text).intent).toBe("buying");
  });
});

describe("classifier - true positives selling with price", () => {
  it.each(TRUE_POSITIVES_SELLING_WITH_PRICE)("%s", (text) => {
    const result = classify(text);
    expect(result.intent).toBe("selling");
    expect(result.hasPrice).toBe(true);
  });
});

describe("classifier - true positives selling without price", () => {
  it.each(TRUE_POSITIVES_SELLING_NO_PRICE)("%s", (text) => {
    const result = classify(text);
    expect(result.intent).toBe("selling");
    expect(result.hasPrice).toBe(false);
  });
});

describe("classifier - true negatives", () => {
  it.each(TRUE_NEGATIVES)("%s", (text) => {
    expect(classify(text).intent).toBe("none");
  });
});

describe("classifier normalization", () => {
  it("normalizes punctuation and apostrophe variants", () => {
    expect(classify("Anyone selling???").intent).toBe("buying");
    expect(classify("Can’t go, Sunday ticket").intent).toBe("selling");
  });
});
