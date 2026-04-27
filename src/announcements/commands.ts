import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import { log } from "../logger.js";
import {
  addAnnouncementItem,
  ensureAnnouncementState,
  getAnnouncementItemByIdentifier,
  getLastAnnouncementCycle,
  listActiveAnnouncementItems,
  listAnnouncementItems,
  moveAnnouncementItem,
  publishAnnouncementItem,
  removeAnnouncementItem,
  setAnnouncementItemEnabled,
  setAnnouncementPaused,
  setAnnouncementSchedule,
  updateAnnouncementBody,
  type AnnouncementActor,
} from "./store.js";
import { formatBundlePreview, formatNextAnnouncement, formatQueueItem, formatQueueList } from "./format.js";
import { isValidLocalDate, isValidLocalTime } from "./time.js";
import { sendAnnouncementBundleNow } from "./scheduler.js";

type AnnouncementCommandActor = AnnouncementActor & {
  role: "owner" | "moderator";
};

type PendingConfirmation = {
  token: string;
  expiresAt: number;
  description: string;
  run: () => Promise<string>;
};

const CONFIRMATION_TTL_MS = 60_000;
const pendingConfirmations = new Map<string, PendingConfirmation>();

const getConfirmToken = (): string => `confirm ${Math.random().toString(36).slice(2, 8)}`;

const consumeConfirmation = (actorUserId: string, text: string): PendingConfirmation | null => {
  const pending = pendingConfirmations.get(actorUserId);
  if (!pending) {
    return null;
  }

  if (Date.now() > pending.expiresAt) {
    pendingConfirmations.delete(actorUserId);
    return null;
  }

  if (text.trim().toLowerCase() !== pending.token) {
    return null;
  }

  pendingConfirmations.delete(actorUserId);
  return pending;
};

const requestConfirmation = async (
  sock: Pick<WASocket, "sendMessage">,
  replyJid: string,
  actorUserId: string,
  description: string,
  run: () => Promise<string>,
): Promise<void> => {
  const token = getConfirmToken();
  pendingConfirmations.set(actorUserId, {
    token,
    expiresAt: Date.now() + CONFIRMATION_TTL_MS,
    description,
    run,
  });

  await sock.sendMessage(replyJid, {
    text: `${description}

Reply exactly:
${token}

This confirmation expires in 60 seconds.`,
  });
};

const parseIdentifier = (tokens: string[]): string | null => tokens[2] ?? null;

const requireQuotedText = async (
  sock: Pick<WASocket, "sendMessage">,
  replyJid: string,
  quotedText: string | null,
): Promise<string | null> => {
  const body = quotedText?.trim();
  if (!body) {
    await sock.sendMessage(replyJid, {
      text: "Reply to the announcement text you want me to store, then send this command.",
    });
    return null;
  }
  return quotedText;
};

export const handleAnnouncementCommand = async (
  sock: Pick<WASocket, "sendMessage">,
  actor: AnnouncementCommandActor,
  replyJid: string,
  text: string,
  quotedText: string | null,
  config: Config,
  groups: ReadonlyMap<string, string>,
): Promise<boolean> => {
  const confirmation = consumeConfirmation(actor.userId ?? actor.label, text);
  if (confirmation) {
    const result = await confirmation.run();
    await sock.sendMessage(replyJid, { text: result });
    log("announcement.confirmed", { actorUserId: actor.userId, description: confirmation.description });
    return true;
  }

  const tokens = text.trim().split(/\s+/).filter(Boolean);
  const root = tokens[0]?.toLowerCase();
  if (root !== "!announce" && root !== "!announcements") {
    return false;
  }

  ensureAnnouncementState(config);
  const subcommand = tokens[1]?.toLowerCase() ?? "list";

  if (subcommand === "list") {
    await sock.sendMessage(replyJid, { text: formatQueueList(listAnnouncementItems()) });
    return true;
  }

  if (subcommand === "show") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? getAnnouncementItemByIdentifier(identifier) : null;
    await sock.sendMessage(replyJid, { text: item ? formatQueueItem(item) : "No announcement item found for that id or position." });
    return true;
  }

  if (subcommand === "preview") {
    await sock.sendMessage(replyJid, { text: formatBundlePreview(listAnnouncementItems()) });
    return true;
  }

  if (subcommand === "next") {
    const state = ensureAnnouncementState(config);
    const targetLabel = groups.get(config.announcementsTargetGroupJid) ?? (config.announcementsTargetGroupJid || "(not configured)");
    await sock.sendMessage(replyJid, {
      text: formatNextAnnouncement(state, listActiveAnnouncementItems().length, targetLabel, getLastAnnouncementCycle()),
    });
    return true;
  }

  if (subcommand === "add") {
    const body = await requireQuotedText(sock, replyJid, quotedText);
    if (!body) {
      return true;
    }
    const item = addAnnouncementItem(body, actor);
    await sock.sendMessage(replyJid, {
      text: `Added draft announcement ${item.position} (${item.id.slice(0, 8)}). Use !announce publish ${item.position} when it is ready.`,
    });
    return true;
  }

  if (subcommand === "edit") {
    const identifier = parseIdentifier(tokens);
    const body = await requireQuotedText(sock, replyJid, quotedText);
    if (!identifier || !body) {
      await sock.sendMessage(replyJid, { text: "Usage: reply to replacement text, then send !announce edit <id|position>" });
      return true;
    }
    const item = updateAnnouncementBody(identifier, body, actor);
    await sock.sendMessage(replyJid, {
      text: item ? `Updated announcement ${item.position} (${item.id.slice(0, 8)}).` : "No announcement item found for that id or position.",
    });
    return true;
  }

  if (subcommand === "publish") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? publishAnnouncementItem(identifier, actor) : null;
    await sock.sendMessage(replyJid, {
      text: item ? `Published announcement ${item.position} (${item.id.slice(0, 8)}).` : "Usage: !announce publish <id|position>",
    });
    return true;
  }

  if (subcommand === "on" || subcommand === "off") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? setAnnouncementItemEnabled(identifier, subcommand === "on", actor) : null;
    await sock.sendMessage(replyJid, {
      text: item
        ? `Announcement ${item.position} is now ${item.enabled ? "on" : "off"}.`
        : `Usage: !announce ${subcommand} <id|position>`,
    });
    return true;
  }

  if (subcommand === "move") {
    const identifier = parseIdentifier(tokens);
    const position = Number(tokens[3]);
    const item = identifier ? moveAnnouncementItem(identifier, position, actor) : null;
    await sock.sendMessage(replyJid, {
      text: item ? `Moved announcement ${item.id.slice(0, 8)} to position ${item.position}.` : "Usage: !announce move <id|position> <newPosition>",
    });
    return true;
  }

  if (subcommand === "remove") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? getAnnouncementItemByIdentifier(identifier) : null;
    if (!item) {
      await sock.sendMessage(replyJid, { text: "Usage: !announce remove <id|position>" });
      return true;
    }
    await requestConfirmation(
      sock,
      replyJid,
      actor.userId ?? actor.label,
      `Remove announcement ${item.position} (${item.id.slice(0, 8)})?`,
      async () => {
        removeAnnouncementItem(item.id, actor);
        return `Removed announcement ${item.position} (${item.id.slice(0, 8)}).`;
      },
    );
    return true;
  }

  if (subcommand === "schedule") {
    const date = tokens[2];
    const time = tokens[3];
    if (!date || !time || !isValidLocalDate(date) || !isValidLocalTime(time)) {
      await sock.sendMessage(replyJid, { text: "Usage: !announce schedule YYYY-MM-DD HH:mm" });
      return true;
    }
    await requestConfirmation(
      sock,
      replyJid,
      actor.userId ?? actor.label,
      `Set next announcement send to ${date} ${time} (${config.announcementsTimezone})?`,
      async () => {
        setAnnouncementSchedule({ date, time, timezone: config.announcementsTimezone });
        return `Next announcement send set to ${date} ${time} (${config.announcementsTimezone}).`;
      },
    );
    return true;
  }

  if (subcommand === "pause" || subcommand === "resume") {
    const state = setAnnouncementPaused(subcommand === "pause");
    await sock.sendMessage(replyJid, { text: `Announcements are now ${state.paused ? "paused" : "running"}.` });
    return true;
  }

  if (subcommand === "test") {
    const active = listActiveAnnouncementItems();
    if (active.length === 0) {
      await sock.sendMessage(replyJid, { text: "No active published announcement items to test." });
      return true;
    }
    for (const item of active) {
      await sock.sendMessage(replyJid, { text: item.body });
    }
    return true;
  }

  if (subcommand === "send-now") {
    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, { text: "Only owners can use !announce send-now." });
      return true;
    }
    await requestConfirmation(
      sock,
      replyJid,
      actor.userId ?? actor.label,
      `Send ${listActiveAnnouncementItems().length} active announcement item(s) to the announcements chat now?`,
      async () => {
        await sendAnnouncementBundleNow(sock, config);
        return "Announcement send-now has run. Use !announce next to check the latest cycle result.";
      },
    );
    return true;
  }

  await sock.sendMessage(replyJid, {
    text: "Usage: !announce list | show | preview | next | add | edit | publish | on | off | move | remove | schedule | pause | resume | test | send-now",
  });
  return true;
};
