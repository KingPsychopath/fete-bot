import { describe, expect, it } from "vitest";

import { buildGroupInviteLinkReply, classifyGroupInviteLinkRequest } from "../groupInviteLink.js";

const TRUE_POSITIVES = [
  "How can I invite/add someone to the group?x",
  "How can I invite someone to the group?",
  "How do I add my friend to the whatsapp?",
  "What is the chat link?",
  "Anyone got the group link?",
  "Can someone send the WhatsApp invite link please",
  "send group invite pls",
  "group invite?",
  "can someone add me to the chat",
  "where's the channel link",
  "link for the chat?",
  "how do I join the group",
  "is there a join link?",
] as const;

const TRUE_NEGATIVES = [
  "Can someone send the RA link?",
  "The group chat is busy today",
  "I'll invite someone later",
  "Add someone on Instagram",
  "Send the group photo please",
  "What's the link between these two sets?",
  "What is the ticket link?",
  "Where is the map link?",
  "Can I join you at the bar?",
  "The channel is under the lightning bolt",
  "How can I invite good energy into the group?",
] as const;

describe("group invite link request classifier", () => {
  it.each(TRUE_POSITIVES)("%s -> matched", (text) => {
    const result = classifyGroupInviteLinkRequest(text);
    expect(result.matched).toBe(true);
    expect(result.reason).toBe("group_invite_link_request");
    expect(result.matchedSignal).not.toBeNull();
  });

  it.each(TRUE_NEGATIVES)("%s -> ignored", (text) => {
    expect(classifyGroupInviteLinkRequest(text).matched).toBe(false);
  });

  it("builds the configured reply text", () => {
    expect(buildGroupInviteLinkReply("@name")).toBe(
      "Hey @name - if you're looking for the group invite link, please go to https://fete.outofofficecollective.co.uk. You can find it in the dropdown menu under the lightning bolt in the top right hand corner.",
    );
  });
});
