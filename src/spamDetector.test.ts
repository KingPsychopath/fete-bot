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

    expect(detector.check("sender@s.whatsapp.net", "same message")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "same   message")).toEqual({ spam: false });
    expect(detector.check("sender@s.whatsapp.net", "same message")).toEqual({
      spam: true,
      reason: "duplicate_message",
      action: "delete",
    });
  });

  it("warns on phone numbers while ignoring phone-like text inside URLs", () => {
    const detector = new SpamDetector();

    expect(detector.check("sender@s.whatsapp.net", "call me on +44 7911 123456")).toEqual({
      spam: true,
      reason: "phone_number",
      action: "warn",
    });
    expect(detector.check("sender@s.whatsapp.net", "music https://example.com/+447911123456")).toEqual({
      spam: false,
    });
  });

  it("deletes message floods and resets after inactivity", () => {
    const detector = new SpamDetector();
    const nowSpy = vi.spyOn(Date, "now");

    for (let index = 0; index < 7; index += 1) {
      nowSpy.mockReturnValueOnce(10_000 + index * 1_000);
      expect(detector.check("sender@s.whatsapp.net", `message ${index}`)).toEqual({ spam: false });
    }

    nowSpy.mockReturnValueOnce(17_000);
    expect(detector.check("sender@s.whatsapp.net", "message 7")).toEqual({
      spam: true,
      reason: "message_flood",
      action: "delete",
    });

    nowSpy.mockReturnValueOnce(90_000);
    expect(detector.check("sender@s.whatsapp.net", "after a pause")).toEqual({ spam: false });
  });
});
