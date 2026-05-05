export type ModerationReplyContext = {
  sourceGroupJid: string;
  sourceMsgId: string | null;
  sourceText: string;
  reason: string | null;
};

type StoredModerationReplyContext = {
  context: ModerationReplyContext;
  createdAt: number;
};

const CONTEXT_TTL_MS = 24 * 60 * 60 * 1000;
const CONTEXT_MAX_ENTRIES = 2_000;
const contextsByReplyKey = new Map<string, StoredModerationReplyContext>();

const getReplyKey = (groupJid: string, replyMsgId: string): string => `${groupJid}::${replyMsgId}`;

const pruneContexts = (nowMs = Date.now()): void => {
  for (const [key, value] of contextsByReplyKey) {
    if (nowMs - value.createdAt > CONTEXT_TTL_MS) {
      contextsByReplyKey.delete(key);
    }
  }

  const overflow = contextsByReplyKey.size - CONTEXT_MAX_ENTRIES;
  if (overflow <= 0) {
    return;
  }

  let deleted = 0;
  for (const key of contextsByReplyKey.keys()) {
    contextsByReplyKey.delete(key);
    deleted += 1;

    if (deleted >= overflow) {
      return;
    }
  }
};

export const recordModerationReplyContext = (
  groupJid: string,
  replyMsgId: string | null | undefined,
  context: ModerationReplyContext,
): void => {
  if (!replyMsgId) {
    return;
  }

  const nowMs = Date.now();
  contextsByReplyKey.set(getReplyKey(groupJid, replyMsgId), { context, createdAt: nowMs });
  pruneContexts(nowMs);
};

export const getModerationReplyContext = (
  groupJid: string,
  replyMsgId: string | null | undefined,
): ModerationReplyContext | null => {
  if (!replyMsgId) {
    return null;
  }

  const key = getReplyKey(groupJid, replyMsgId);
  const stored = contextsByReplyKey.get(key);
  if (!stored) {
    return null;
  }

  if (Date.now() - stored.createdAt > CONTEXT_TTL_MS) {
    contextsByReplyKey.delete(key);
    return null;
  }

  return stored.context;
};
