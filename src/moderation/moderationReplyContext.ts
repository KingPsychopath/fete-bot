export type ModerationReplyContext = {
  sourceGroupJid: string;
  sourceMsgId: string | null;
  sourceText: string;
  reason: string | null;
};

const contextsByReplyKey = new Map<string, ModerationReplyContext>();

const getReplyKey = (groupJid: string, replyMsgId: string): string => `${groupJid}::${replyMsgId}`;

export const recordModerationReplyContext = (
  groupJid: string,
  replyMsgId: string | null | undefined,
  context: ModerationReplyContext,
): void => {
  if (!replyMsgId) {
    return;
  }

  contextsByReplyKey.set(getReplyKey(groupJid, replyMsgId), context);
};

export const getModerationReplyContext = (
  groupJid: string,
  replyMsgId: string | null | undefined,
): ModerationReplyContext | null => {
  if (!replyMsgId) {
    return null;
  }

  return contextsByReplyKey.get(getReplyKey(groupJid, replyMsgId)) ?? null;
};
