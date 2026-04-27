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
  type AnnouncementQueueItemRow,
} from "./store.js";
import { formatBundlePreview, formatNextAnnouncement, formatQueueItem, formatQueueList, formatRawQueueItem } from "./format.js";
import { isValidLocalDate, isValidLocalTime } from "./time.js";
import { sendAnnouncementBundleNow } from "./scheduler.js";
import {
  analyseAnnouncementMentions,
  buildAnnouncementMentionCandidates,
  buildGroupMentionContext,
  type AnnouncementMentionCandidate,
} from "./mentions.js";

type AnnouncementCommandActor = AnnouncementActor & {
  role: "owner" | "moderator";
};

type AnnouncementCommandOptions = {
  allowedSubcommands?: readonly string[];
  restrictedMessage?: string;
};

type PendingConfirmation = {
  token: string;
  expiresAt: number;
  description: string;
  run: () => Promise<string>;
};

const CONFIRMATION_TTL_MS = 60_000;
const pendingConfirmations = new Map<string, PendingConfirmation>();

export const ANNOUNCEMENT_HELP_TEXT = `*Announcement Help*

Use this in DM with the bot for queue management. Queue positions are the numbers shown by !announce list.

*Normal workflow*
1. Send the announcement text to the bot as a normal message.
2. Reply to that text with: !announce add
3. Check the draft with: !announce show {position}
4. To copy formatting markers for editing: !announce raw {position}
5. When ready: !announce publish {position}
6. Preview the live bundle: !announce preview
7. Send the live bundle to yourself, or to the group you run it in: !announce test
8. Check timing/status: !announce next
9. Run a final safety check: !announce check
10. Owner-only real group test: !announce test-group {groupJid}

*Important*
- publish does not send immediately.
- preview and test only include items that are published and on.
- show works for drafts, published items, on items, and off items.
- raw shows the stored text in a copyable code block, including WhatsApp *bold* and _italic_ markers.
- list only shows compact previews, not full message bodies.
- test does not advance the recurring schedule.
- In groups, only help/list/show/raw/preview/next/check/test are allowed. Add, edit, publish, remove, schedule, and send-now must be done in DM.
- To mention group chats, type a configured label like @FDLM General. The bot also understands known group names and exact @120...@g.us group JIDs when it can resolve them.
- The automatic schedule only runs when announcements are enabled in config.

*Queue commands*
!announce list
!announce show {id|position}
!announce raw {id|position}
!announce preview
!announce next
!announce check
!announce add
!announce edit {id|position}
!announce publish {id|position}
!announce on {id|position}
!announce off {id|position}
!announce move {id|position} {newPosition}
!announce remove {id|position}

*Schedule commands*
!announce schedule YYYY-MM-DD HH:mm
!announce pause
!announce resume

Schedule format is local 24-hour time in the configured timezone.
Example: !announce schedule 2026-04-30 10:00

*Owner only*
!announce send-now
!announce test-group {groupJid}

Commands that can remove, reschedule, or send to the real announcements chat ask for a confirmation token first.`;

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

const getWillSendReason = (item: AnnouncementQueueItemRow): string => {
  if (item.status !== "published") {
    return "no - draft";
  }

  if (!item.enabled) {
    return "no - off";
  }

  return "yes";
};

const formatMentionDiagnostics = (
  body: string,
  candidates: readonly AnnouncementMentionCandidate[],
): string => {
  const analysis = analyseAnnouncementMentions(body, candidates);
  const resolved = analysis.resolved.length > 0
    ? analysis.resolved.map((mention) => `- ${mention.token} -> ${mention.label} (${mention.jid})`).join("\n")
    : "- none";
  const unresolved = analysis.unresolved.length > 0
    ? analysis.unresolved.map((token) => `- ${token}`).join("\n")
    : "- none";

  return `Detected mentions:
${resolved}
Unresolved @ text:
${unresolved}`;
};

const formatQueueItemWithDiagnostics = (
  item: AnnouncementQueueItemRow,
  candidates: readonly AnnouncementMentionCandidate[],
): string => `${formatQueueItem(item)}

Will send: ${getWillSendReason(item)}
${formatMentionDiagnostics(item.body, candidates)}`;

const formatAnnouncementCheck = (
  config: Config,
  groups: ReadonlyMap<string, string>,
): string => {
  const state = ensureAnnouncementState(config);
  const items = listAnnouncementItems();
  const active = items.filter((item) => item.status === "published" && item.enabled);
  const candidates = buildAnnouncementMentionCandidates(config.announcementsGroupMentions, groups);
  const targetLabel = groups.get(config.announcementsTargetGroupJid) ?? (config.announcementsTargetGroupJid || "(not configured)");
  const targetStatus = config.announcementsTargetGroupJid
    ? groups.has(config.announcementsTargetGroupJid)
      ? "configured and known"
      : "configured but not seen by bot yet"
    : "missing";
  const itemLines = items.length > 0
    ? items.map((item) => {
        const analysis = analyseAnnouncementMentions(item.body, candidates);
        const resolved = analysis.resolved.length > 0
          ? analysis.resolved.map((mention) => `${mention.token}->${mention.label}`).join(", ")
          : "none";
        const unresolved = analysis.unresolved.length > 0 ? ` | unresolved: ${analysis.unresolved.join(", ")}` : "";
        return `${item.position}. ${item.id.slice(0, 8)} | ${item.status} | ${item.enabled ? "on" : "off"} | will send: ${getWillSendReason(item)} | mentions: ${resolved}${unresolved}`;
      }).join("\n")
    : "No queue items.";
  const lastCycle = getLastAnnouncementCycle();

  return `Announcement check

Enabled: ${config.announcementsEnabled ? "yes" : "no"}
Paused: ${state.paused ? "yes" : "no"}
Target: ${targetLabel}
Target status: ${targetStatus}
Next send: ${state.nextLocalDate} ${state.nextLocalTime} (${state.timezone})
Active published items for next cycle: ${active.length}
Last cycle: ${lastCycle ? `${lastCycle.status} at ${lastCycle.completedAt ?? lastCycle.updatedAt}${lastCycle.error ? ` (${lastCycle.error})` : ""}` : "none"}

Queue:
${itemLines}`;
};

const sleep = (delayMs: number): Promise<void> =>
  delayMs > 0 ? new Promise((resolve) => setTimeout(resolve, delayMs)) : Promise.resolve();

const sendActiveBundleToGroup = async (
  sock: Pick<WASocket, "sendMessage">,
  targetGroupJid: string,
  candidates: readonly AnnouncementMentionCandidate[],
): Promise<number> => {
  const active = listActiveAnnouncementItems();
  let sent = 0;
  for (const [index, item] of active.entries()) {
    if (index > 0) {
      await sleep(1_500);
    }

    const contextInfo = buildGroupMentionContext(item.body, candidates);
    await sock.sendMessage(targetGroupJid, contextInfo ? { text: item.body, contextInfo } : { text: item.body });
    sent += 1;
  }

  return sent;
};

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
  options: AnnouncementCommandOptions = {},
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
  const mentionCandidates = buildAnnouncementMentionCandidates(config.announcementsGroupMentions, groups);

  if (options.allowedSubcommands && !options.allowedSubcommands.includes(subcommand)) {
    await sock.sendMessage(replyJid, {
      text: options.restrictedMessage ?? "Use DM with the bot for that announcement command.",
    });
    return true;
  }

  if (subcommand === "help") {
    await sock.sendMessage(replyJid, { text: ANNOUNCEMENT_HELP_TEXT });
    return true;
  }

  if (subcommand === "list") {
    await sock.sendMessage(replyJid, { text: formatQueueList(listAnnouncementItems()) });
    return true;
  }

  if (subcommand === "show") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? getAnnouncementItemByIdentifier(identifier) : null;
    await sock.sendMessage(replyJid, {
      text: item ? formatQueueItemWithDiagnostics(item, mentionCandidates) : "No announcement item found for that id or position.",
    });
    return true;
  }

  if (subcommand === "raw" || subcommand === "copy") {
    const identifier = parseIdentifier(tokens);
    const item = identifier ? getAnnouncementItemByIdentifier(identifier) : null;
    await sock.sendMessage(replyJid, {
      text: item ? formatRawQueueItem(item) : "No announcement item found for that id or position.",
    });
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

  if (subcommand === "check") {
    await sock.sendMessage(replyJid, { text: formatAnnouncementCheck(config, groups) });
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
    await sendActiveBundleToGroup(sock, replyJid, mentionCandidates);
    return true;
  }

  if (subcommand === "test-group" || subcommand === "test-chat") {
    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, { text: "Only owners can use !announce test-group." });
      return true;
    }

    const targetGroupJid = tokens[2] === "target"
      ? config.announcementsTargetGroupJid
      : tokens[2];
    if (!targetGroupJid?.endsWith("@g.us")) {
      await sock.sendMessage(replyJid, { text: "Usage: !announce test-group {groupJid|target}" });
      return true;
    }

    const activeCount = listActiveAnnouncementItems().length;
    if (activeCount === 0) {
      await sock.sendMessage(replyJid, { text: "No active published announcement items to test." });
      return true;
    }

    const targetLabel = groups.get(targetGroupJid) ?? targetGroupJid;
    await requestConfirmation(
      sock,
      replyJid,
      actor.userId ?? actor.label,
      `Send ${activeCount} active announcement test item(s) to ${targetLabel} (${targetGroupJid}) without advancing the schedule?`,
      async () => {
        const sent = await sendActiveBundleToGroup(sock, targetGroupJid, mentionCandidates);
        return `Sent ${sent} announcement test item(s) to ${targetLabel}. The recurring schedule was not changed.`;
      },
    );
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
        await sendAnnouncementBundleNow(sock, config, new Date(), () => groups);
        return "Announcement send-now has run. Use !announce next to check the latest cycle result.";
      },
    );
    return true;
  }

  await sock.sendMessage(replyJid, {
    text: "Usage: !announce help | list | show | raw | preview | next | check | add | edit | publish | on | off | move | remove | schedule | pause | resume | test | test-group | send-now",
  });
  return true;
};
