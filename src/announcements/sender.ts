import type { WASocket } from "@whiskeysockets/baileys";

import type { AnnouncementGroupMentionConfig } from "../config.js";
import { warn } from "../logger.js";
import { buildGroupMentionContext } from "./mentions.js";
import {
  markCycleItemFailed,
  markCycleItemSent,
  type AnnouncementCycleItemRow,
} from "./store.js";

const parseMentions = (value: string): AnnouncementGroupMentionConfig[] => {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return parsed.filter(
      (entry): entry is AnnouncementGroupMentionConfig =>
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as AnnouncementGroupMentionConfig).label === "string" &&
        typeof (entry as AnnouncementGroupMentionConfig).jid === "string",
    );
  } catch {
    return [];
  }
};

const sleep = (delayMs: number): Promise<void> =>
  delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();

export const sendAnnouncementCycleItems = async (
  sock: Pick<WASocket, "sendMessage">,
  targetGroupJid: string,
  items: readonly AnnouncementCycleItemRow[],
  options: { interMessageDelayMs?: number; now?: Date } = {},
): Promise<{ sent: number; failed: number; firstError: string | null }> => {
  let sent = 0;
  let failed = 0;
  let firstError: string | null = null;
  const interMessageDelayMs = options.interMessageDelayMs ?? 2_500;

  for (const [index, item] of items.entries()) {
    if (index > 0) {
      await sleep(interMessageDelayMs);
    }

    try {
      const mentions = parseMentions(item.groupMentionsJson);
      const contextInfo = buildGroupMentionContext(item.body, mentions);
      await sock.sendMessage(targetGroupJid, contextInfo ? { text: item.body, contextInfo } : { text: item.body });
      markCycleItemSent(item.id, options.now);
      sent += 1;
    } catch (sendError) {
      const message = sendError instanceof Error ? sendError.message : String(sendError);
      markCycleItemFailed(item.id, message, options.now);
      warn("announcement.item_failed", {
        itemId: item.id,
        queueItemId: item.queueItemId,
        position: item.position,
        targetGroupJid,
        error: sendError,
      });
      firstError ??= message;
      failed += 1;
      break;
    }
  }

  return { sent, failed, firstError };
};
