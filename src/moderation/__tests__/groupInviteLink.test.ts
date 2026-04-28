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
  "Is there a link I can send for someone to join this chat?",
  "Is there a link I can send my friend so they can join the group?",
  "Anyone got a link I can share with my mate to join the WhatsApp?",
  "What link do I send someone to get into the chat?",
  "Can I get a link to pass to someone so they can be added to the community?",
  "Does anyone have a link my friend can use to join the group?",
  "Where's the link people can use to get in the whatsapp?",
  "Need a link for my mate to join the channel",
  "link for this chat?",
  "what's the link to our group?",
  "How can I invite my friends to this group?",
  "Can someone add friends to this chat?",
  "Can I get the link to add my friend to this group?",
  "Is there a link to invite someone to the current chat?",
  "Can someone send a link to add people to that WhatsApp?",
  "Anyone got a link so I can add whoever to this group?",
  "Need the group link to add my mates",
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
  "Is there a link I can send for someone to buy a ticket?",
  "Is there a link I can send for someone to join the mailing list?",
  "What link do I send someone for the venue map?",
  "Can I share the group photo link with my friend?",
  "My friend can join us later in the chat about trains",
  "Does anyone have a link my friend can use for the timetable?",
  "Can someone send the link between the groups?",
  "Send me the link after you join the call",
  "Can I get the link to add my friend on Instagram?",
  "Is there a link to invite someone to the calendar event?",
  "Can someone send a link to add people to that spreadsheet?",
  "Need the ticket link to add my mates",
  "What's the link to our playlist?",
  "Can someone add friends to this photo album?",
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
