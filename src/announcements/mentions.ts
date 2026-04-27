import type { proto } from "@whiskeysockets/baileys";

import type { AnnouncementGroupMentionConfig } from "../config.js";

export const buildGroupMentionContext = (
  text: string,
  configuredMentions: readonly AnnouncementGroupMentionConfig[],
): proto.IContextInfo | undefined => {
  const groupMentions = configuredMentions.filter((mention) => {
    const pattern = new RegExp(`@${escapeRegExp(mention.label)}(?=\\b|\\s|$)`, "iu");
    return pattern.test(text);
  });

  if (groupMentions.length === 0) {
    return undefined;
  }

  return {
    groupMentions: groupMentions.map((mention) => ({
      groupJid: mention.jid,
      groupSubject: mention.label,
    })),
  };
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
