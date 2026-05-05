import { describe, expect, it } from "vitest";

import { getModerationReplyContext, recordModerationReplyContext } from "../moderationReplyContext.js";

describe("moderation reply context", () => {
  it("links a bot moderation reply back to its source message", () => {
    recordModerationReplyContext("group@g.us", "bot-reply-1", {
      sourceGroupJid: "group@g.us",
      sourceMsgId: "source-1",
      sourceText: "is anyone selling two tickets",
      reason: "ticket_marketplace_review",
    });

    expect(getModerationReplyContext("group@g.us", "bot-reply-1")).toEqual({
      sourceGroupJid: "group@g.us",
      sourceMsgId: "source-1",
      sourceText: "is anyone selling two tickets",
      reason: "ticket_marketplace_review",
    });
  });

  it("keeps reply ids scoped by group", () => {
    recordModerationReplyContext("first@g.us", "same-reply-id", {
      sourceGroupJid: "first@g.us",
      sourceMsgId: "source-1",
      sourceText: "first message",
      reason: "spam",
    });
    recordModerationReplyContext("second@g.us", "same-reply-id", {
      sourceGroupJid: "second@g.us",
      sourceMsgId: "source-2",
      sourceText: "second message",
      reason: "link",
    });

    expect(getModerationReplyContext("first@g.us", "same-reply-id")?.sourceText).toBe("first message");
    expect(getModerationReplyContext("second@g.us", "same-reply-id")?.sourceText).toBe("second message");
  });
});
