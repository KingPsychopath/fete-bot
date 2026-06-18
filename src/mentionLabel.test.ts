import { describe, expect, it } from "vitest";

import { formatMentionLabel, getMentionTargetJid } from "./mentionLabel.js";

describe("mention labels", () => {
  it("prefers a linkable mention token over a push name for group copy", () => {
    expect(formatMentionLabel("447700900000@s.whatsapp.net", " Ayo💁🏾‍♀️\n@everyone ", null)).toBe("@447700900000");
  });

  it("falls back to the mentionable sender token when there is no display name", () => {
    expect(formatMentionLabel("111222333@lid", null, "447700900000@s.whatsapp.net")).toBe("@111222333");
  });

  it("uses the phone JID as the target when the sender JID is not mentionable", () => {
    expect(getMentionTargetJid("sender@g.us", "447700900000@s.whatsapp.net")).toBe("447700900000@s.whatsapp.net");
  });

  it("uses a cleaned push name only when there is no mentionable target", () => {
    expect(formatMentionLabel("sender@g.us", " Ayo💁🏾‍♀️\n@everyone ", null)).toBe("Ayo💁🏾‍♀️ everyone");
  });

  it("falls back to there when no mention target or name exists", () => {
    expect(formatMentionLabel("sender@g.us", null, null)).toBe("there");
  });
});
