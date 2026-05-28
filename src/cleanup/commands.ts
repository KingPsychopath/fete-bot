import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import type { ActorRole } from "../db.js";
import { describeUser, resolveUser } from "../identity.js";
import { formatJidForDisplay, isProtectedGroupMember, parseToJid } from "../utils.js";
import { isCleanupDmHardPaused } from "./scheduler.js";
import {
  buildCleanupDmMessage,
  buildCleanupPublicMessage,
  formatCleanupMemberList,
  formatCleanupStarted,
  formatCleanupStatus,
} from "./format.js";
import {
  createCleanupCampaign,
  extendCleanupCampaign,
  findCleanupMemberByUserOrJid,
  getCleanupStats,
  getLatestCleanupCampaign,
  getOpenCleanupCampaign,
  listCleanupCandidateMembers,
  listCleanupWhitelistedMembers,
  recordCleanupMessage,
  recordCleanupSignal,
  setCleanupCampaignStatus,
  updateCleanupDmThrottle,
  type CleanupMemberSeed,
} from "./store.js";

export type CleanupActor = {
  userId: string;
  label: string;
  role: ActorRole;
};

const CLEANUP_HELP = `*Cleanup commands*

!cleanup start {duration?} [batch=50] [interval=60m] [channel=https://...]
!cleanup status
!cleanup whitelist {limit?}
!cleanup candidates {limit?}
!cleanup pause
!cleanup resume
!cleanup throttle [batch=10] [interval=6h]
!cleanup extend {duration}
!cleanup stop
!cleanup keep {userId|phone|jid}
!cleanup keepmany {phone/user ids...}

Safety: cleanup never removes members. It only whitelists responders and lists purge candidates for admins.`;

const durationMsFromToken = (token: string | undefined, fallbackMs: number): number | null => {
  if (!token) {
    return fallbackMs;
  }

  const match = token.trim().toLowerCase().match(/^(\d+)(m|h|d)?$/u);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2] ?? "h";
  const multiplier = unit === "m" ? 60_000 : unit === "h" ? 60 * 60_000 : 24 * 60 * 60_000;
  return Math.min(Math.max(value * multiplier, 5 * 60_000), 14 * 24 * 60 * 60_000);
};

const durationLabel = (durationMs: number): string => {
  const minutes = Math.round(durationMs / 60_000);
  if (minutes % (24 * 60) === 0) {
    const days = minutes / (24 * 60);
    return `${days} day${days === 1 ? "" : "s"}`;
  }
  if (minutes % 60 === 0) {
    const hours = minutes / 60;
    return `${hours} hour${hours === 1 ? "" : "s"}`;
  }
  return `${minutes} minute${minutes === 1 ? "" : "s"}`;
};

const parsePositiveNumberOption = (
  token: string | undefined,
  prefix: string,
  fallback: number,
  max: number,
): number => {
  if (!token?.startsWith(prefix)) {
    return fallback;
  }

  const parsed = Number(token.slice(prefix.length));
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
};

const parseIntervalOption = (token: string | undefined, fallbackMinutes: number): number => {
  if (!token?.startsWith("interval=")) {
    return fallbackMinutes;
  }

  const durationMs = durationMsFromToken(token.slice("interval=".length), fallbackMinutes * 60_000);
  return durationMs ? Math.max(1, Math.round(durationMs / 60_000)) : fallbackMinutes;
};

const parseChannelOption = (tokens: readonly string[], fallback: string | null): string | null => {
  const explicit = tokens.find((token) => token.startsWith("channel="));
  if (!explicit) {
    return fallback;
  }

  const value = explicit.slice("channel=".length).trim();
  if (!value || value.toLowerCase() === "none") {
    return null;
  }
  return value;
};

const getCommandParts = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

const getManualKeepIdentifiers = (input: string): string[] => {
  const cleaned = input.trim().replace(/^@/, "");
  const phoneJid = parseToJid(cleaned);
  const digits = cleaned.replace(/\D/gu, "");
  const digitJid = digits.length >= 7 && digits.length <= 15 ? parseToJid(digits) : null;
  return [cleaned, phoneJid, digitJid].filter((identifier): identifier is string => Boolean(identifier));
};

const extractKeepManyIdentifiers = (text: string): string[] => {
  const [, , , rest = ""] = text.match(/^(\S+)\s+(\S+)\s*([\s\S]*)$/u) ?? [];
  const candidates = rest
    .split(/\r?\n/u)
    .flatMap((line) => line.match(/[+]?\d[\d ().-]{6,}\d|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9]{7,15}@s\.whatsapp\.net/giu) ?? []);
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
};

const getManagedGroupJids = (
  config: Config,
  groups: ReadonlyMap<string, string>,
): string[] => config.allowedGroupJids.length > 0 ? [...config.allowedGroupJids] : Array.from(groups.keys());

const getPublicTargetJids = (
  config: Config,
  groups: ReadonlyMap<string, string>,
): string[] => {
  const targets = config.cleanupPublicTargetJids.length > 0
    ? config.cleanupPublicTargetJids
    : getManagedGroupJids(config, groups);
  return Array.from(new Set(targets));
};

const primaryJidForParticipant = (participant: {
  id: string;
  lid?: string | null;
  phoneNumber?: string | null;
}): string | null =>
  parseToJid(participant.phoneNumber ?? "") ??
  (participant.id.endsWith("@s.whatsapp.net") || participant.id.endsWith("@lid") ? participant.id : null) ??
  participant.lid ??
  null;

const collectCleanupMembers = async (
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
  targetGroupJids: readonly string[],
): Promise<CleanupMemberSeed[]> => {
  const members = new Map<string, CleanupMemberSeed>();

  for (const groupJid of targetGroupJids) {
    const metadata = groupMetadataByJid.get(groupJid);
    if (!metadata) {
      continue;
    }

    for (const participant of metadata.participants) {
      const primaryJid = primaryJidForParticipant(participant);
      if (!primaryJid || selfJids.has(primaryJid)) {
        continue;
      }

      const resolved = await resolveUser({
        participantJid: participant.id,
        phoneJid: parseToJid(participant.phoneNumber ?? ""),
        lidJid: participant.lid ?? null,
        selfJids,
        reason: "metadata_sync",
      });
      if (!resolved) {
        continue;
      }

      const existing = members.get(resolved.userId);
      if (existing) {
        continue;
      }

      members.set(resolved.userId, {
        userId: resolved.userId,
        displayName: describeUser(resolved.userId)?.displayName,
        primaryJid,
        firstSeenGroupJid: groupJid,
        protected: isProtectedGroupMember(
          resolved.userId,
          resolved.knownAliases,
          groupJid,
          config,
          groupMetadataByJid,
        ),
      });
    }
  }

  return Array.from(members.values());
};

const sendPublicNotices = async (
  sock: WASocket,
  campaignId: string,
  publicTargets: readonly string[],
  publicMessage: string,
): Promise<string[]> => {
  const sentTargets: string[] = [];
  for (const targetJid of publicTargets) {
    try {
      const sent = await sock.sendMessage(targetJid, { text: publicMessage });
      recordCleanupMessage(campaignId, targetJid, sent?.key.id, "public", null);
      sentTargets.push(targetJid);
    } catch {
      // The campaign should continue even if one public target rejects the notice.
    }
  }
  return sentTargets;
};

const getActiveOrReply = async (sock: WASocket, replyJid: string): Promise<ReturnType<typeof getOpenCleanupCampaign>> => {
  const campaign = getOpenCleanupCampaign();
  if (!campaign) {
    await sock.sendMessage(replyJid, { text: "No active cleanup campaign. Use `!cleanup start 72h` first." });
  }
  return campaign;
};

const getLatestOrReply = async (sock: WASocket, replyJid: string): Promise<ReturnType<typeof getLatestCleanupCampaign>> => {
  const campaign = getOpenCleanupCampaign() ?? getLatestCleanupCampaign();
  if (!campaign) {
    await sock.sendMessage(replyJid, { text: "No cleanup campaign found. Use `!cleanup start 72h` first." });
  }
  return campaign;
};

export const handleCleanupCommand = async (
  sock: WASocket,
  actor: CleanupActor,
  replyJid: string,
  text: string,
  config: Config,
  groups: ReadonlyMap<string, string>,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<boolean> => {
  const parts = getCommandParts(text);
  const root = parts[0]?.toLowerCase();
  if (root !== "!cleanup") {
    return false;
  }

  const subcommand = parts[1]?.toLowerCase() ?? "status";
  if (subcommand === "help") {
    await sock.sendMessage(replyJid, { text: CLEANUP_HELP });
    return true;
  }

  if (subcommand === "start" || subcommand === "restart") {
    if (subcommand === "restart") {
      const open = getOpenCleanupCampaign();
      if (open) {
        setCleanupCampaignStatus(open.id, "stopped");
      }
    }

    const existing = getOpenCleanupCampaign();
    if (existing) {
      await sock.sendMessage(replyJid, {
        text: `Cleanup campaign already ${existing.status}. Use \`!cleanup status\`, \`!cleanup pause\`, \`!cleanup resume\`, or \`!cleanup stop\`.`,
      });
      return true;
    }

    const optionTokens = parts.slice(2);
    const durationToken = optionTokens.find((token) => !token.includes("="));
    const durationMs = durationMsFromToken(durationToken, 72 * 60 * 60_000);
    if (!durationMs) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup start {duration?}. Example: `!cleanup start 72h`" });
      return true;
    }

    const batchToken = optionTokens.find((token) => token.startsWith("batch="));
    const intervalToken = optionTokens.find((token) => token.startsWith("interval="));
    const batchSize = parsePositiveNumberOption(batchToken, "batch=", config.cleanupDmBatchSize, 250);
    const batchIntervalMinutes = parseIntervalOption(intervalToken, config.cleanupDmBatchIntervalMinutes);
    const channelLink = parseChannelOption(optionTokens, config.cleanupChannelLink);
    const label = durationLabel(durationMs);
    const publicMessage = buildCleanupPublicMessage(label, channelLink);
    const dmMessage = buildCleanupDmMessage(label, channelLink);
    const publicTargets = getPublicTargetJids(config, groups);
    const members = await collectCleanupMembers(config, groupMetadataByJid, selfJids, getManagedGroupJids(config, groups));

    if (members.length === 0) {
      await sock.sendMessage(replyJid, {
        text: "Couldn't find any members in managed group metadata. Wait for the bot to refresh groups, then try again.",
      });
      return true;
    }

    const campaign = createCleanupCampaign({
      durationMs,
      actorUserId: actor.userId,
      actorLabel: actor.label,
      channelLink,
      publicMessage,
      dmMessage,
      batchSize,
      batchIntervalMinutes,
      members,
    });

    const sentTargets = await sendPublicNotices(sock, campaign.id, publicTargets, publicMessage);
    const stats = getCleanupStats(campaign.id);
    await sock.sendMessage(replyJid, {
      text: stats ? formatCleanupStarted(stats, sentTargets) : "Cleanup campaign started.",
    });
    return true;
  }

  if (subcommand === "status") {
    const campaign = await getLatestOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const stats = getCleanupStats(campaign.id);
    await sock.sendMessage(replyJid, {
      text: stats ? formatCleanupStatus(stats, Date.now(), { hardPauseDms: isCleanupDmHardPaused() }) : "Couldn't load cleanup status.",
    });
    return true;
  }

  if (subcommand === "pause" || subcommand === "resume" || subcommand === "stop") {
    const campaign = await getActiveOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const nextStatus = subcommand === "pause" ? "paused" : subcommand === "resume" ? "active" : "stopped";
    const updated = setCleanupCampaignStatus(campaign.id, nextStatus);
    await sock.sendMessage(replyJid, {
      text: updated ? formatCleanupStatus(getCleanupStats(updated.id)!) : `Cleanup ${subcommand} failed.`,
    });
    return true;
  }

  if (subcommand === "throttle" || subcommand === "rate") {
    const campaign = await getActiveOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const optionTokens = parts.slice(2);
    const batchToken = optionTokens.find((token) => token.startsWith("batch="));
    const intervalToken = optionTokens.find((token) => token.startsWith("interval="));
    if (!batchToken && !intervalToken) {
      await sock.sendMessage(replyJid, {
        text: "Usage: !cleanup throttle batch=10 interval=6h\nTip: use !cleanup pause immediately if the account is restricted.",
      });
      return true;
    }

    const batchSize = parsePositiveNumberOption(batchToken, "batch=", campaign.batchSize, 250);
    const batchIntervalMinutes = parseIntervalOption(intervalToken, campaign.batchIntervalMinutes);
    const nowMs = Date.now();
    const nextBatchNotBefore = Math.max(
      campaign.nextBatchNotBefore ?? nowMs,
      nowMs + batchIntervalMinutes * 60_000,
    );
    const updated = updateCleanupDmThrottle(
      campaign.id,
      batchSize,
      batchIntervalMinutes,
      nextBatchNotBefore,
      nowMs,
    );
    await sock.sendMessage(replyJid, {
      text: updated ? formatCleanupStatus(getCleanupStats(updated.id)!) : "Cleanup throttle update failed.",
    });
    return true;
  }

  if (subcommand === "extend") {
    const campaign = await getActiveOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const extensionMs = durationMsFromToken(parts[2], 0);
    if (!extensionMs) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup extend {duration}. Example: `!cleanup extend 24h`" });
      return true;
    }

    const updated = extendCleanupCampaign(campaign.id, extensionMs);
    await sock.sendMessage(replyJid, {
      text: updated ? formatCleanupStatus(getCleanupStats(updated.id)!) : "Cleanup extend failed.",
    });
    return true;
  }

  if (subcommand === "whitelist" || subcommand === "candidates") {
    const campaign = await getLatestOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const limit = Number(parts[2] ?? "50");
    const safeLimit = Number.isInteger(limit) && limit > 0 ? Math.min(limit, 200) : 50;
    const members = subcommand === "whitelist"
      ? listCleanupWhitelistedMembers(campaign.id, safeLimit)
      : listCleanupCandidateMembers(campaign.id, safeLimit);
    await sock.sendMessage(replyJid, {
      text: formatCleanupMemberList(
        subcommand === "whitelist" ? `Whitelisted members (${members.length})` : `Purge candidates (${members.length})`,
        members,
        subcommand === "whitelist" ? "Nobody is whitelisted yet." : "No purge candidates right now.",
      ),
    });
    return true;
  }

  if (subcommand === "keep") {
    const campaign = await getActiveOrReply(sock, replyJid);
    const identifier = parts[2];
    if (!campaign || !identifier) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup keep {userId|phone|jid}" });
      return true;
    }

    const member = findCleanupMemberByUserOrJid(campaign.id, getManualKeepIdentifiers(identifier));
    if (!member) {
      await sock.sendMessage(replyJid, {
        text: `Couldn't find ${formatJidForDisplay(identifier)} in the active cleanup campaign. Use \`!cleanup candidates 100\` to confirm the exact entry.`,
      });
      return true;
    }

    const recorded = recordCleanupSignal(campaign.id, member.userId, "manual", replyJid, null);
    await sock.sendMessage(replyJid, {
      text: recorded
        ? `Whitelisted ${member.displayName ?? formatJidForDisplay(member.primaryJid)} manually.`
        : `${member.displayName ?? formatJidForDisplay(member.primaryJid)} was already whitelisted.`,
    });
    return true;
  }

  if (subcommand === "keepmany") {
    const campaign = await getActiveOrReply(sock, replyJid);
    const identifiers = extractKeepManyIdentifiers(text);
    if (!campaign || identifiers.length === 0) {
      await sock.sendMessage(replyJid, {
        text: "Usage: !cleanup keepmany {phone/user ids...}\nPaste one or many phone numbers after the command.",
      });
      return true;
    }

    let added = 0;
    let already = 0;
    const notFound: string[] = [];
    const seenUserIds = new Set<string>();

    for (const identifier of identifiers.slice(0, 200)) {
      const member = findCleanupMemberByUserOrJid(campaign.id, getManualKeepIdentifiers(identifier));
      if (!member) {
        notFound.push(identifier);
        continue;
      }

      if (seenUserIds.has(member.userId)) {
        continue;
      }
      seenUserIds.add(member.userId);

      const recorded = recordCleanupSignal(campaign.id, member.userId, "manual", replyJid, null);
      if (recorded) {
        added += 1;
      } else {
        already += 1;
      }
    }

    await sock.sendMessage(replyJid, {
      text: [
        "Bulk keep complete.",
        `Added: ${added}`,
        `Already whitelisted: ${already}`,
        `Not found: ${notFound.length}`,
        notFound.length > 0 ? `Not found examples: ${notFound.slice(0, 10).join(", ")}` : null,
      ].filter(Boolean).join("\n"),
    });
    return true;
  }

  await sock.sendMessage(replyJid, { text: CLEANUP_HELP });
  return true;
};
