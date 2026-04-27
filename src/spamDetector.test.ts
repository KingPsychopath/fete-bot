import { afterEach, describe, expect, it, vi } from "vitest";

import { SpamDetector } from "./spamDetector.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SpamDetector", () => {
  it("deletes the third duplicate message within the duplicate window", () => {
    const detector = new SpamDetector();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);

    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "same message with enough text")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "same   message with enough text")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "same message with enough text")).toEqual({
      spam: true,
      reason: "duplicate_message",
      action: "delete",
    });
  });

  it("ignores short duplicate chat messages", () => {
    const detector = new SpamDetector();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(1_000)
      .mockReturnValueOnce(2_000)
      .mockReturnValueOnce(3_000);

    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "yes")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", " yes ")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "yes")).toEqual({ spam: false });
  });

  it("warns on phone numbers while ignoring phone-like text inside URLs", () => {
    const detector = new SpamDetector();

    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "call me on +44 7911 123456")).toEqual({
      spam: true,
      reason: "phone_number",
      action: "warn",
    });
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "music https://example.com/+447911123456")).toEqual({
      spam: false,
    });
  });

  it("warns once for message floods before deleting later messages and resets after inactivity", () => {
    const detector = new SpamDetector();
    const nowSpy = vi.spyOn(Date, "now");

    for (let index = 0; index < 19; index += 1) {
      nowSpy.mockReturnValueOnce(10_000 + index * 1_000);
      expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", `message ${index}`)).toEqual({ spam: false });
    }

    nowSpy.mockReturnValueOnce(29_000);
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "message 19")).toEqual({
      spam: true,
      reason: "message_flood",
      action: "warn",
    });

    for (let index = 20; index < 24; index += 1) {
      nowSpy.mockReturnValueOnce(10_000 + index * 1_000);
      expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", `message ${index}`)).toEqual({ spam: false });
    }

    nowSpy.mockReturnValueOnce(34_000);
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "message 24")).toEqual({
      spam: true,
      reason: "message_flood",
      action: "delete",
    });

    nowSpy.mockReturnValueOnce(90_000);
    expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", "after a pause")).toEqual({ spam: false });
  });

  it("tracks message floods per sender and group", () => {
    const detector = new SpamDetector();
    const nowSpy = vi.spyOn(Date, "now");

    for (let index = 0; index < 19; index += 1) {
      nowSpy.mockReturnValueOnce(10_000 + index * 1_000);
      expect(detector.check("sender@s.whatsapp.net", "group-1@g.us", `group 1 message ${index}`)).toEqual({ spam: false });
    }

    nowSpy.mockReturnValueOnce(29_000);
    expect(detector.check("sender@s.whatsapp.net", "group-2@g.us", "group 2 message")).toEqual({ spam: false });
  });

  it("supports custom duplicate and flood limits", () => {
    const duplicateDetector = new SpamDetector({
      duplicateMinLength: 5,
    });
    const nowSpy = vi.spyOn(Date, "now");

    nowSpy.mockReturnValueOnce(1_000);
    expect(duplicateDetector.check("sender@s.whatsapp.net", "group-1@g.us", "short")).toEqual({ spam: false });
    nowSpy.mockReturnValueOnce(2_000);
    expect(duplicateDetector.check("sender@s.whatsapp.net", "group-1@g.us", "short")).toEqual({ spam: false });
    nowSpy.mockReturnValueOnce(3_000);
    expect(duplicateDetector.check("sender@s.whatsapp.net", "group-1@g.us", "short")).toEqual({
      spam: true,
      reason: "duplicate_message",
      action: "delete",
    });

    const floodDetector = new SpamDetector({
      floodWarnMessageLimit: 3,
      floodDeleteMessageLimit: 5,
    });

    nowSpy.mockReturnValueOnce(10_000);
    expect(floodDetector.check("sender@s.whatsapp.net", "group-1@g.us", "message 1")).toEqual({ spam: false });
    nowSpy.mockReturnValueOnce(11_000);
    expect(floodDetector.check("sender@s.whatsapp.net", "group-1@g.us", "message 2")).toEqual({ spam: false });
    nowSpy.mockReturnValueOnce(12_000);
    expect(floodDetector.check("sender@s.whatsapp.net", "group-1@g.us", "message 3")).toEqual({
      spam: true,
      reason: "message_flood",
      action: "warn",
    });
    nowSpy.mockReturnValueOnce(13_000);
    expect(floodDetector.check("sender@s.whatsapp.net", "group-1@g.us", "message 4")).toEqual({ spam: false });
    nowSpy.mockReturnValueOnce(14_000);
    expect(floodDetector.check("sender@s.whatsapp.net", "group-1@g.us", "message 5")).toEqual({
      spam: true,
      reason: "message_flood",
      action: "delete",
    });
  });
});
