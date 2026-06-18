import type { GroupMetadata, WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import { getUserAliases, type ActorRole } from "../db.js";
import { describeUser, findParticipantJidForUser, resolveUser } from "../identity.js";
import { log, warn } from "../logger.js";
import { formatJidForDisplay, isGroupAdmin, isProtectedGroupMember, parseToJid } from "../utils.js";
import { isCleanupDmHardPaused } from "./scheduler.js";
import {
  buildCleanupDmMessage,
  buildCleanupPublicMessage,
  formatCleanupMemberList,
  formatCleanupStarted,
  formatCleanupStatus,
} from "./format.js";
import {
  cancelAllUnfinishedCleanupRemovalJobs,
  cancelCleanupRemovalJob,
  createCleanupCampaign,
  continueLatestCleanupCampaignPaused,
  claimCleanupRemovalJob,
  completeCleanupRemovalJobIfFinished,
  createCleanupRemovalJob,
  extendCleanupCampaign,
  findCleanupMemberByUserOrJid,
  getCleanupMember,
  getCleanupRemovalJob,
  getCleanupRemovalJobSummary,
  getCleanupStats,
  getLatestCleanupCampaign,
  getOpenCleanupCampaign,
  listCleanupCandidateMembers,
  listCleanupDmMembers,
  listCleanupMembers,
  listCleanupRemovalCandidateMembers,
  listCleanupRemovalJobSummaries,
  listCleanupRemovalJobActions,
  listUnfinishedCleanupRemovalJobs,
  markCleanupRemovalActionFailed,
  markCleanupRemovalActionRunning,
  markCleanupRemovalActionSkipped,
  markCleanupRemovalActionSucceeded,
  markCleanupRemovalJobFailed,
  listCleanupWhitelistedMembers,
  recordCleanupMessage,
  recordCleanupSignal,
  removeCleanupWhitelist,
  setCleanupCampaignStatus,
  type CleanupRemovalAction as StoredCleanupRemovalAction,
  type CleanupRemovalJobSummary,
  type CleanupMemberSeed,
} from "./store.js";
import { CLEANUP_DM_RATE_LIMIT } from "./policy.js";

export type CleanupActor = {
  userId: string;
  label: string;
  role: ActorRole;
};

const CLEANUP_HELP = `*Cleanup commands*

!cleanup start {duration?} [channel=https://...] [public=off] [carry=off]
!cleanup continue {duration?}
!cleanup notice
!cleanup status
!cleanup whitelist {limit?}
!cleanup candidates {limit?}
!cleanup dms {sent|failed|pending|all?} {limit?}
!cleanup remove-preview {limit?} group={groupJid}|all=true
!cleanup remove-start {limit?} group={groupJid}|all=true confirm=REMOVE [delay=10s] [group-delay=60s]
!cleanup remove-queue {limit?}
!cleanup remove-job {jobId} {limit?}
!cleanup remove-clear {jobId|all} confirm=CLEAR
!cleanup pause
!cleanup resume
!cleanup extend {duration}
!cleanup stop
!cleanup keep {userId|phone|jid}
!cleanup unkeep {userId|phone|jid}
!cleanup keepmany {phone/user ids...}

Safety: cleanup watching never removes members automatically. Owner-only remove-start removes confirmed candidate batches and does not ban.`;

const CLEANUP_REMOVE_CONFIRM_TOKEN = "REMOVE";
const CLEANUP_REMOVE_CLEAR_CONFIRM_TOKEN = "CLEAR";
const CLEANUP_REMOVE_DEFAULT_LIMIT = 5;
const CLEANUP_REMOVE_MAX_LIMIT = 25;
const CLEANUP_REMOVE_DEFAULT_DELAY_MS = 10_000;
const CLEANUP_REMOVE_DEFAULT_GROUP_DELAY_MS = 60_000;
const CLEANUP_REMOVE_MIN_DELAY_MS = 5_000;
const CLEANUP_REMOVE_MIN_GROUP_DELAY_MS = 15_000;
const CLEANUP_REMOVE_MAX_DELAY_MS = 10 * 60_000;
const CLEANUP_REMOVE_BLOCKED_PREVIEW_LIMIT = 10;

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

const delayMsFromToken = (
  token: string | undefined,
  fallbackMs: number,
  minMs = CLEANUP_REMOVE_MIN_DELAY_MS,
  maxMs = CLEANUP_REMOVE_MAX_DELAY_MS,
): number | null => {
  if (!token) {
    return fallbackMs;
  }

  const match = token.trim().toLowerCase().match(/^(\d+)(ms|s|m)?$/u);
  if (!match) {
    return null;
  }

  const value = Number(match[1]);
  const unit = match[2] ?? "s";
  const multiplier = unit === "ms" ? 1 : unit === "s" ? 1_000 : 60_000;
  const delayMs = value * multiplier;
  return Math.min(Math.max(delayMs, minMs), maxMs);
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

const parseBooleanOption = (
  tokens: readonly string[],
  names: readonly string[],
  fallback: boolean,
): boolean => {
  const token = tokens.find((candidate) => names.some((name) => candidate.startsWith(`${name}=`)));
  if (!token) {
    return fallback;
  }

  const value = token.slice(token.indexOf("=") + 1).trim().toLowerCase();
  if (["0", "false", "no", "off", "none"].includes(value)) {
    return false;
  }
  if (["1", "true", "yes", "on"].includes(value)) {
    return true;
  }
  return fallback;
};

const getOptionValue = (tokens: readonly string[], name: string): string | null => {
  const token = tokens.find((candidate) => candidate.startsWith(`${name}=`));
  return token ? token.slice(name.length + 1).trim() : null;
};

const getCommandParts = (text: string): string[] => text.trim().split(/\s+/).filter(Boolean);

const getManualKeepIdentifiers = (input: string): string[] => {
  const cleaned = input.trim().replace(/^@/, "");
  const phoneJid = parseToJid(cleaned);
  const digits = cleaned.replace(/\D/gu, "");
  const digitJid = digits.length >= 7 && digits.length <= 15 ? parseToJid(digits) : null;
  return [cleaned, phoneJid, digitJid].filter((identifier): identifier is string => Boolean(identifier));
};

const digitsOnly = (value: string): string => value.replace(/\D/gu, "");

const findLongestCommonDigitRun = (left: string, right: string): number => {
  const shorter = left.length <= right.length ? left : right;
  for (let length = Math.min(shorter.length, 10); length >= 7; length -= 1) {
    for (let start = 0; start <= shorter.length - length; start += 1) {
      if (right.includes(shorter.slice(start, start + length))) {
        return length;
      }
    }
  }
  return 0;
};

const getNearbyMemberSuggestions = (
  identifier: string,
  members: readonly { displayName: string | null; primaryJid: string }[],
): string[] => {
  const wanted = digitsOnly(identifier);
  if (wanted.length < 7) {
    return [];
  }

  return members
    .map((member) => {
      const actual = digitsOnly(member.primaryJid);
      const commonSuffix = [...Array(Math.min(wanted.length, actual.length) + 1).keys()]
        .reverse()
        .find((length) => length >= 4 && wanted.endsWith(actual.slice(-length))) ?? 0;
      return {
        member,
        score: Math.max(commonSuffix + 2, findLongestCommonDigitRun(wanted, actual)),
      };
    })
    .filter((entry) => entry.score >= 7)
    .sort((left, right) => right.score - left.score)
    .slice(0, 3)
    .map(({ member }) => `${member.displayName ?? "Unknown"} (${formatJidForDisplay(member.primaryJid)})`);
};

const extractKeepManyIdentifiers = (text: string): string[] => {
  const [, , , rest = ""] = text.match(/^(\S+)\s+(\S+)\s*([\s\S]*)$/u) ?? [];
  const candidates = rest
    .split(/\r?\n/u)
    .flatMap((line) => line.match(/[+]?\d[\d ().-]{6,}\d|[0-9a-f]{8}-[0-9a-f-]{27,}|[0-9]{7,15}@s\.whatsapp\.net/giu) ?? []);
  return Array.from(new Set(candidates.map((candidate) => candidate.trim()).filter(Boolean)));
};

const parsePositiveLimit = (value: string | undefined, fallback: number, max: number): number => {
  const limit = Number(value ?? `${fallback}`);
  return Number.isInteger(limit) && limit > 0 ? Math.min(limit, max) : fallback;
};

const parseCleanupRemoveLimit = (tokens: readonly string[]): number => {
  const explicitLimit = getOptionValue(tokens, "limit");
  const positionalLimit = tokens.find((token) => !token.includes("=") && /^\d+$/u.test(token));
  return parsePositiveLimit(explicitLimit ?? positionalLimit, CLEANUP_REMOVE_DEFAULT_LIMIT, CLEANUP_REMOVE_MAX_LIMIT);
};

const formatTimestamp = (timestampMs: number | null): string => {
  if (!timestampMs) {
    return "not sent";
  }
  return new Date(timestampMs).toLocaleString("en-GB", {
    dateStyle: "short",
    timeStyle: "short",
    timeZone: "Europe/London",
  });
};

const formatCleanupDmMembers = (
  title: string,
  members: ReturnType<typeof listCleanupDmMembers>,
): string => {
  if (members.length === 0) {
    return `${title}\n\nNo matching cleanup DMs.`;
  }

  return [
    title,
    "",
    ...members.map((member, index) => {
      const label = member.displayName?.trim() || member.primaryJid;
      const details = [
        `status ${member.dmStatus}`,
        member.dmStatus === "sent" ? `sent ${formatTimestamp(member.dmSentAt)}` : null,
        member.dmStatus === "failed" && member.dmError ? `error ${member.dmError}` : null,
      ].filter(Boolean);
      return `${index + 1}. ${label} (${formatJidForDisplay(member.primaryJid)}) — ${details.join(", ")}`;
    }),
  ].join("\n");
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

const getRemovalTargetGroupJids = (
  config: Config,
  groups: ReadonlyMap<string, string>,
  tokens: readonly string[],
): { groupJids: string[]; error: string | null } => {
  const managedGroupJids = getManagedGroupJids(config, groups);
  const groupJid = getOptionValue(tokens, "group");
  const all = parseBooleanOption(tokens, ["all"], false);

  if (groupJid) {
    if (!managedGroupJids.includes(groupJid)) {
      return { groupJids: [], error: `That group is not managed by this bot: ${groupJid}` };
    }
    return { groupJids: [groupJid], error: null };
  }

  if (all) {
    return { groupJids: managedGroupJids, error: null };
  }

  if (managedGroupJids.length === 1) {
    return { groupJids: managedGroupJids, error: null };
  }

  return {
    groupJids: [],
    error: [
      "Choose a cleanup removal scope explicitly.",
      "Use `group={groupJid}` for one chat, or `all=true` for every managed chat.",
      "",
      "Managed chats:",
      ...managedGroupJids.map((jid) => `- ${groups.get(jid) ?? jid} (${jid})`),
    ].join("\n"),
  };
};

type CleanupRemovalPlanEntry = {
  member: ReturnType<typeof listCleanupRemovalCandidateMembers>[number];
  removals: { groupJid: string; participantJid: string }[];
  blockedGroups: { groupJid: string; participantJid: string; reason: "bot_not_admin" }[];
};

const countCleanupRemovalActions = (plan: readonly CleanupRemovalPlanEntry[]): number =>
  plan.reduce((count, entry) => count + entry.removals.length, 0);

const countCleanupRemovablePeople = (plan: readonly CleanupRemovalPlanEntry[]): number =>
  plan.filter((entry) => entry.removals.length > 0).length;

const countCleanupBlockedGroups = (plan: readonly CleanupRemovalPlanEntry[]): number =>
  plan.reduce((count, entry) => count + entry.blockedGroups.length, 0);

const pluralize = (count: number, singular: string, plural = `${singular}s`): string =>
  `${count} ${count === 1 ? singular : plural}`;

const buildCleanupRemovalPlan = (
  campaignId: string,
  groupJids: readonly string[],
  peopleLimit: number,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): CleanupRemovalPlanEntry[] => {
  const candidates = listCleanupRemovalCandidateMembers(campaignId, Math.max(peopleLimit * 20, 50));
  const plan: CleanupRemovalPlanEntry[] = [];
  let plannedPeople = 0;
  let blockedPreviewEntries = 0;
  const selfAliases = Array.from(selfJids);
  const botAdminGroupJids = new Set(
    groupJids.filter((groupJid) => isGroupAdmin(selfAliases, groupJid, groupMetadataByJid)),
  );

  for (const member of candidates) {
    const removals: CleanupRemovalPlanEntry["removals"] = [];
    const blockedGroups: CleanupRemovalPlanEntry["blockedGroups"] = [];

    for (const groupJid of groupJids) {
      const metadata = groupMetadataByJid.get(groupJid);
      const participantJid = findParticipantJidForUser(member.userId, metadata);
      if (!participantJid) {
        continue;
      }
      const knownAliases = [member.primaryJid, ...getUserAliases(member.userId).map((alias) => alias.alias)];
      if (isProtectedGroupMember(member.userId, knownAliases, groupJid, config, groupMetadataByJid)) {
        continue;
      }
      if (!botAdminGroupJids.has(groupJid)) {
        blockedGroups.push({ groupJid, participantJid, reason: "bot_not_admin" });
        continue;
      }
      removals.push({ groupJid, participantJid });
    }

    if (removals.length === 0) {
      if (blockedGroups.length > 0 && blockedPreviewEntries < CLEANUP_REMOVE_BLOCKED_PREVIEW_LIMIT) {
        plan.push({ member, removals: [], blockedGroups });
        blockedPreviewEntries += 1;
      }
      continue;
    }

    plan.push({ member, removals, blockedGroups });
    plannedPeople += 1;
    if (plannedPeople >= peopleLimit) {
      break;
    }
  }

  return plan;
};

const formatRemovalScope = (groupJids: readonly string[], groups: ReadonlyMap<string, string>): string =>
  groupJids.length === 1 ? `${groups.get(groupJids[0] ?? "") ?? groupJids[0]}` : `${groupJids.length} managed chats`;

const isMentionableJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");

const getCleanupRemovalMentionTarget = (entry: CleanupRemovalPlanEntry): string | null => {
  const aliases = getUserAliases(entry.member.userId).map((alias) => alias.alias);
  const phoneAlias = aliases.find((alias) => alias.endsWith("@s.whatsapp.net"));
  if (phoneAlias) {
    return phoneAlias;
  }

  const liveParticipantJid = entry.removals.map((removal) => removal.participantJid).find(isMentionableJid);
  if (liveParticipantJid) {
    return liveParticipantJid;
  }

  const blockedParticipantJid = entry.blockedGroups.map((blocked) => blocked.participantJid).find(isMentionableJid);
  if (blockedParticipantJid) {
    return blockedParticipantJid;
  }

  return isMentionableJid(entry.member.primaryJid) ? entry.member.primaryJid : null;
};

const formatMentionTargetLabel = (mentionTargetJid: string | null, fallbackJid: string): string => {
  const target = mentionTargetJid ?? fallbackJid;
  if (target.endsWith("@s.whatsapp.net")) {
    return `@${target.replace(/@s\.whatsapp\.net$/iu, "")}`;
  }
  if (target.endsWith("@lid")) {
    return `@${target.replace(/@lid$/iu, "")}`;
  }
  return formatJidForDisplay(target);
};

const formatCleanupRemovalPlan = (
  title: string,
  plan: readonly CleanupRemovalPlanEntry[],
  groups: ReadonlyMap<string, string>,
): { text: string; mentions: string[] } => {
  if (plan.length === 0) {
    return {
      text: `${title}\n\nNo removable non-whitelisted candidates found in the selected chat scope.`,
      mentions: [],
    };
  }

  const mentions: string[] = [];
  const lines = [
    title,
    "",
    ...plan.map((entry, index) => {
      const label = entry.member.displayName?.trim() || entry.member.primaryJid;
      const mentionTarget = getCleanupRemovalMentionTarget(entry);
      if (mentionTarget) {
        mentions.push(mentionTarget);
      }
      const mentionLabel = formatMentionTargetLabel(mentionTarget, entry.member.primaryJid);
      const removalCount = entry.removals.length;
      const removalLabel = `${removalCount} removal${removalCount === 1 ? "" : "s"}`;
      const targetGroups = entry.removals.map((removal) => groups.get(removal.groupJid) ?? removal.groupJid);
      const blockedGroups = entry.blockedGroups.map((blocked) => groups.get(blocked.groupJid) ?? blocked.groupJid);
      const details = [
        targetGroups.length > 0 ? `${removalLabel}: ${targetGroups.join(", ")}` : null,
        blockedGroups.length > 0 ? `blocked, bot is not admin: ${blockedGroups.join(", ")}` : null,
      ].filter(Boolean);
      return `${index + 1}. ${label} (${mentionLabel}) — ${details.join("; ")}`;
    }),
  ];

  return { text: lines.join("\n"), mentions: Array.from(new Set(mentions)) };
};

const shortJobId = (jobId: string): string => jobId.slice(0, 8);

const formatRemovalJobProgress = (summary: CleanupRemovalJobSummary): string => {
  const unfinished = summary.pending + summary.running;
  return [
    `${summary.succeeded}/${summary.job.totalActions} removed`,
    summary.failed > 0 ? `${summary.failed} failed` : null,
    summary.skipped > 0 ? `${summary.skipped} skipped` : null,
    unfinished > 0 ? `${unfinished} queued` : null,
  ].filter(Boolean).join(", ");
};

const formatRemovalJobSummaryList = (
  title: string,
  summaries: readonly CleanupRemovalJobSummary[],
  groups: ReadonlyMap<string, string>,
): string => {
  if (summaries.length === 0) {
    return `${title}\n\nNo cleanup removal jobs found.`;
  }

  return [
    title,
    "",
    ...summaries.map((summary, index) => {
      const groupLabels = summary.job.scopeGroupJids
        .map((groupJid) => groups.get(groupJid) ?? groupJid)
        .slice(0, 3);
      const extraGroups = Math.max(0, summary.job.scopeGroupJids.length - groupLabels.length);
      return [
        `${index + 1}. ${shortJobId(summary.job.id)} — ${summary.job.status}, ${formatRemovalJobProgress(summary)}`,
        `   Scope: ${groupLabels.join(", ")}${extraGroups > 0 ? ` +${extraGroups}` : ""}`,
        `   Created: ${formatTimestamp(summary.job.createdAt)} by ${summary.job.createdByLabel}`,
        `   Full id: ${summary.job.id}`,
      ].join("\n");
    }),
    "",
    "Inspect: `!cleanup remove-job {jobId}`",
    `Clear: \`!cleanup remove-clear {jobId|all} confirm=${CLEANUP_REMOVE_CLEAR_CONFIRM_TOKEN}\``,
  ].join("\n");
};

const formatRemovalActionMentionLabel = (action: StoredCleanupRemovalAction): string => {
  const mentionTarget = isMentionableJid(action.participantJid) ? action.participantJid : null;
  return formatMentionTargetLabel(mentionTarget, action.participantJid);
};

const formatCleanupRemovalJobDetails = (
  summary: CleanupRemovalJobSummary,
  actions: readonly StoredCleanupRemovalAction[],
  groups: ReadonlyMap<string, string>,
  limit: number,
): { text: string; mentions: string[] } => {
  const mentions = actions
    .map((action) => action.participantJid)
    .filter(isMentionableJid);
  const groupLabels = summary.job.scopeGroupJids.map((groupJid) => groups.get(groupJid) ?? groupJid);
  const actionLines = actions.map((action) => {
    const label = action.displayName?.trim() || action.participantJid;
    const details = [
      action.status,
      `attempts ${action.attemptCount}`,
      action.lastStatus ? `status ${action.lastStatus}` : null,
      action.lastError ? `note ${action.lastError}` : null,
    ].filter(Boolean);
    return `${action.actionOrder}. ${label} (${formatRemovalActionMentionLabel(action)}) — ${groups.get(action.groupJid) ?? action.groupJid} — ${details.join(", ")}`;
  });

  return {
    text: [
      `Cleanup removal job ${summary.job.id}`,
      "",
      `Status: ${summary.job.status}`,
      `Progress: ${formatRemovalJobProgress(summary)}`,
      `People requested: ${summary.job.totalPeople}/${summary.job.peopleLimit}`,
      `Scope: ${groupLabels.join(", ")}`,
      `Delay: ${Math.round(summary.job.delayMs / 1000)}s in-chat; ${Math.round(summary.job.groupDelayMs / 1000)}s between chats`,
      `Created: ${formatTimestamp(summary.job.createdAt)} by ${summary.job.createdByLabel}`,
      summary.job.lastError ? `Last note: ${summary.job.lastError}` : null,
      "",
      `Actions (${actions.length}/${summary.job.totalActions}${summary.job.totalActions > limit ? `, showing first ${limit}` : ""}):`,
      ...actionLines,
      "",
      summary.job.status === "queued" || summary.job.status === "running"
        ? `Clear: \`!cleanup remove-clear ${summary.job.id} confirm=${CLEANUP_REMOVE_CLEAR_CONFIRM_TOKEN}\``
        : "This job is finished; clear only affects queued/running jobs.",
    ].filter(Boolean).join("\n"),
    mentions: Array.from(new Set(mentions)),
  };
};

const wait = (delayMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

type CleanupRemovalAction = {
  member: CleanupRemovalPlanEntry["member"];
  removal: CleanupRemovalPlanEntry["removals"][number];
};

const groupCleanupRemovalActions = (
  plan: readonly CleanupRemovalPlanEntry[],
  groupOrder: readonly string[],
): { groupJid: string; actions: CleanupRemovalAction[] }[] => {
  const actionsByGroupJid = new Map<string, CleanupRemovalAction[]>();
  for (const groupJid of groupOrder) {
    actionsByGroupJid.set(groupJid, []);
  }

  for (const entry of plan) {
    for (const removal of entry.removals) {
      const actions = actionsByGroupJid.get(removal.groupJid) ?? [];
      actions.push({ member: entry.member, removal });
      actionsByGroupJid.set(removal.groupJid, actions);
    }
  }

  return Array.from(actionsByGroupJid.entries())
    .filter(([, actions]) => actions.length > 0)
    .map(([groupJid, actions]) => ({ groupJid, actions }));
};

const describeError = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

let cleanupRemovalJobInFlight: string | null = null;

const runCleanupRemovalJob = async (
  sock: WASocket,
  jobId: string,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<NonNullable<ReturnType<typeof getCleanupRemovalJobSummary>>> => {
  if (cleanupRemovalJobInFlight && cleanupRemovalJobInFlight !== jobId) {
    throw new Error(`Cleanup removal job ${cleanupRemovalJobInFlight} is already running`);
  }

  cleanupRemovalJobInFlight = jobId;
  let claimed = false;
  try {
    const job = claimCleanupRemovalJob(jobId);
    if (!job) {
      const summary = getCleanupRemovalJobSummary(jobId);
      if (summary) {
        return summary;
      }
      throw new Error(`Cleanup removal job ${jobId} not found`);
    }
    claimed = true;

    let attempted = 0;
    let previousGroupJid: string | null = null;
    const selfAliases = Array.from(selfJids);

    log("cleanup.remove_batch.start", {
      campaignId: job.campaignId,
      jobId: job.id,
      removalActions: job.totalActions,
      delayMs: job.delayMs,
      groupDelayMs: job.groupDelayMs,
      resumed: job.status === "running",
    });

    const actions = listCleanupRemovalJobActions(job.id, ["pending"]);
    for (const action of actions) {
      if (previousGroupJid) {
        await wait(previousGroupJid === action.groupJid ? job.delayMs : job.groupDelayMs);
      }

      const currentJob = getCleanupRemovalJob(job.id);
      if (currentJob?.status === "cancelled") {
        log("cleanup.remove_batch.cancelled", {
          campaignId: job.campaignId,
          jobId: job.id,
          attempted,
        });
        const cancelledSummary = getCleanupRemovalJobSummary(job.id);
        if (cancelledSummary) {
          return cancelledSummary;
        }
        throw new Error(`Cleanup removal job ${job.id} disappeared after cancellation`);
      }

      previousGroupJid = action.groupJid;

      const runningAction = markCleanupRemovalActionRunning(action.id);
      if (!runningAction) {
        continue;
      }
      attempted += 1;

      const member = getCleanupMember(runningAction.campaignId, runningAction.userId);
      if (!member) {
        markCleanupRemovalActionSkipped(runningAction.id, "cleanup member no longer exists");
        continue;
      }

      if (member.whitelistedAt !== null) {
        markCleanupRemovalActionSkipped(runningAction.id, "cleanup member became whitelisted");
        continue;
      }

      const metadata = groupMetadataByJid.get(runningAction.groupJid);
      const liveParticipantJid = findParticipantJidForUser(runningAction.userId, metadata);
      if (!liveParticipantJid) {
        markCleanupRemovalActionSkipped(runningAction.id, "participant is no longer in group");
        continue;
      }

      const knownAliases = [member.primaryJid, ...getUserAliases(runningAction.userId).map((alias) => alias.alias)];
      if (isProtectedGroupMember(runningAction.userId, knownAliases, runningAction.groupJid, config, groupMetadataByJid)) {
        markCleanupRemovalActionSkipped(runningAction.id, "participant is now protected");
        continue;
      }

      if (!isGroupAdmin(selfAliases, runningAction.groupJid, groupMetadataByJid)) {
        markCleanupRemovalActionFailed(runningAction.id, "bot_not_admin", "bot is not admin in group");
        continue;
      }

      try {
        log("cleanup.remove_attempt", {
          campaignId: runningAction.campaignId,
          jobId: job.id,
          actionId: runningAction.id,
          userId: runningAction.userId,
          groupJid: runningAction.groupJid,
          participantJid: liveParticipantJid,
          attempted,
          totalRemovalActions: job.totalActions,
        });
        const result = await sock.groupParticipantsUpdate(
          runningAction.groupJid,
          [liveParticipantJid],
          "remove",
        );
        const status = result?.[0]?.status;
        if (status && status !== "200") {
          markCleanupRemovalActionFailed(runningAction.id, status, `WhatsApp remove returned status ${status}`);
          warn("cleanup.remove_failed", {
            campaignId: runningAction.campaignId,
            jobId: job.id,
            actionId: runningAction.id,
            userId: runningAction.userId,
            groupJid: runningAction.groupJid,
            participantJid: liveParticipantJid,
            status,
          });
        } else {
          markCleanupRemovalActionSucceeded(runningAction.id, status ?? null);
          log("cleanup.remove_ok", {
            campaignId: runningAction.campaignId,
            jobId: job.id,
            actionId: runningAction.id,
            userId: runningAction.userId,
            groupJid: runningAction.groupJid,
            participantJid: liveParticipantJid,
            status: status ?? null,
          });
        }
      } catch (removeError) {
        markCleanupRemovalActionFailed(runningAction.id, null, describeError(removeError));
        warn("cleanup.remove_failed", {
          campaignId: runningAction.campaignId,
          jobId: job.id,
          actionId: runningAction.id,
          userId: runningAction.userId,
          groupJid: runningAction.groupJid,
          participantJid: liveParticipantJid,
          error: removeError,
        });
      }
    }

    const summary = completeCleanupRemovalJobIfFinished(job.id);
    if (!summary) {
      throw new Error(`Cleanup removal job ${job.id} disappeared before completion`);
    }

    log("cleanup.remove_batch.finish", {
      campaignId: job.campaignId,
      jobId: job.id,
      attempted,
      succeeded: summary.succeeded,
      failed: summary.failed,
      skipped: summary.skipped,
      pending: summary.pending,
      running: summary.running,
    });

    return summary;
  } catch (jobError) {
    if (claimed) {
      markCleanupRemovalJobFailed(jobId, describeError(jobError));
    }
    throw jobError;
  } finally {
    cleanupRemovalJobInFlight = null;
  }
};

export const resumeCleanupRemovalJobs = async (
  sock: WASocket,
  config: Config,
  groupMetadataByJid: ReadonlyMap<string, GroupMetadata>,
  selfJids: ReadonlySet<string>,
): Promise<void> => {
  const jobs = listUnfinishedCleanupRemovalJobs(5);
  for (const job of jobs) {
    if (cleanupRemovalJobInFlight) {
      return;
    }

    const before = getCleanupRemovalJobSummary(job.id);
    if (!before || before.pending + before.running === 0) {
      completeCleanupRemovalJobIfFinished(job.id);
      continue;
    }

    log("cleanup.remove_resume.start", {
      campaignId: job.campaignId,
      jobId: job.id,
      pending: before.pending,
      running: before.running,
      succeeded: before.succeeded,
      failed: before.failed,
      skipped: before.skipped,
    });

    try {
      await sock.sendMessage(job.replyJid, {
        text: [
          `Resuming cleanup removal job ${job.id}.`,
          `Remaining: ${before.pending + before.running}/${job.totalActions} removal action(s).`,
          "Queue survived the restart; continuing pending removals only.",
        ].join("\n"),
      });
    } catch (sendError) {
      warn("cleanup.remove_resume_notice_failed", {
        campaignId: job.campaignId,
        jobId: job.id,
        replyJid: job.replyJid,
        error: sendError,
      });
    }

    try {
      const result = await runCleanupRemovalJob(sock, job.id, config, groupMetadataByJid, selfJids);
      await sock.sendMessage(job.replyJid, {
        text: [
          "Cleanup removal batch complete.",
          `Job: ${job.id}`,
          `Removed: ${result.succeeded}`,
          `Failed: ${result.failed}`,
          result.skipped > 0 ? `Skipped: ${result.skipped}` : null,
          "Run `!cleanup candidates 100` or another `!cleanup remove-preview` before the next batch.",
        ].filter(Boolean).join("\n"),
      });
    } catch (resumeError) {
      warn("cleanup.remove_resume_failed", {
        campaignId: job.campaignId,
        jobId: job.id,
        error: resumeError,
      });
      try {
        await sock.sendMessage(job.replyJid, {
          text: `Cleanup removal job ${job.id} failed while resuming: ${describeError(resumeError)}`,
        });
      } catch {
        // The failure is already logged; avoid masking the resume error.
      }
    }
  }
};

const primaryJidForParticipant = (participant: {
  id: string;
  lid?: string | null;
  phoneNumber?: string | null;
}): string | null =>
  (participant.id.endsWith("@lid") ? participant.id : null) ??
  participant.lid ??
  (participant.id.endsWith("@s.whatsapp.net") ? participant.id : null) ??
  parseToJid(participant.phoneNumber ?? "") ??
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

const carryPreviousCleanupWhitelist = (
  members: CleanupMemberSeed[],
  previousCampaignId: string | null,
): CleanupMemberSeed[] => {
  if (!previousCampaignId) {
    return members;
  }

  const previousWhitelistedUserIds = new Set(
    listCleanupWhitelistedMembers(previousCampaignId, 5_000).map((member) => member.userId),
  );
  if (previousWhitelistedUserIds.size === 0) {
    return members;
  }

  return members.map((member) =>
    previousWhitelistedUserIds.has(member.userId)
      ? { ...member, whitelisted: true, whitelistReason: "manual" }
      : member
  );
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
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup start {duration?} [channel=https://...]. Example: `!cleanup start 72h`" });
      return true;
    }

    const supportedOptionPrefixes = ["channel=", "public=", "notice=", "notices=", "carry="];
    const unsupportedOption = optionTokens.find((token) =>
      token.includes("=") && !supportedOptionPrefixes.some((prefix) => token.startsWith(prefix))
    );
    if (unsupportedOption) {
      await sock.sendMessage(replyJid, {
        text: `Unsupported cleanup option: ${unsupportedOption}\nDM batch options are disabled. Cleanup DMs use the fixed safety rate: ${CLEANUP_DM_RATE_LIMIT.messagesPerWindow} every ${CLEANUP_DM_RATE_LIMIT.windowMinutes}m, ${Math.round(CLEANUP_DM_RATE_LIMIT.perMessageDelayMs / 1000)}s apart.`,
      });
      return true;
    }

    const channelLink = parseChannelOption(optionTokens, config.cleanupChannelLink);
    const publicNoticesEnabled = parseBooleanOption(optionTokens, ["public", "notice", "notices"], true);
    const carryPreviousWhitelist = parseBooleanOption(optionTokens, ["carry"], true);
    const label = durationLabel(durationMs);
    const publicMessage = buildCleanupPublicMessage(label, channelLink);
    const dmMessage = buildCleanupDmMessage(label, channelLink);
    const publicTargets = publicNoticesEnabled ? getPublicTargetJids(config, groups) : [];
    const previousCampaign = carryPreviousWhitelist ? getLatestCleanupCampaign() : null;
    const collectedMembers = await collectCleanupMembers(config, groupMetadataByJid, selfJids, getManagedGroupJids(config, groups));
    const members = carryPreviousCleanupWhitelist(collectedMembers, previousCampaign?.id ?? null);

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
      batchSize: CLEANUP_DM_RATE_LIMIT.messagesPerWindow,
      batchIntervalMinutes: CLEANUP_DM_RATE_LIMIT.windowMinutes,
      members,
    });

    const sentTargets = await sendPublicNotices(sock, campaign.id, publicTargets, publicMessage);
    const stats = getCleanupStats(campaign.id);
    await sock.sendMessage(replyJid, {
      text: stats ? formatCleanupStarted(stats, sentTargets) : "Cleanup campaign started.",
    });
    return true;
  }

  if (subcommand === "continue" || subcommand === "reopen") {
    const existing = getOpenCleanupCampaign();
    if (existing) {
      await sock.sendMessage(replyJid, {
        text: `Cleanup campaign already ${existing.status}. Use \`!cleanup status\`, \`!cleanup pause\`, \`!cleanup resume\`, or \`!cleanup stop\`.`,
      });
      return true;
    }

    const durationMs = durationMsFromToken(parts[2], 72 * 60 * 60_000);
    if (!durationMs) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup continue {duration?}. Example: `!cleanup continue 72h`" });
      return true;
    }

    const campaign = continueLatestCleanupCampaignPaused(durationMs);
    const stats = campaign ? getCleanupStats(campaign.id) : null;
    await sock.sendMessage(replyJid, {
      text: stats
        ? `Reopened latest cleanup campaign in PAUSED mode. Use \`!cleanup resume\` when you want DMs to continue.\n\n${formatCleanupStatus(stats, Date.now(), { hardPauseDms: isCleanupDmHardPaused(config) })}`
        : "No previous cleanup campaign found.",
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
      text: stats ? formatCleanupStatus(stats, Date.now(), { hardPauseDms: isCleanupDmHardPaused(config) }) : "Couldn't load cleanup status.",
    });
    return true;
  }

  if (subcommand === "notice" || subcommand === "notices" || subcommand === "public") {
    const campaign = await getActiveOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const publicTargets = getPublicTargetJids(config, groups);
    if (publicTargets.length === 0) {
      await sock.sendMessage(replyJid, { text: "No cleanup public target chats found." });
      return true;
    }

    const sentTargets = await sendPublicNotices(sock, campaign.id, publicTargets, campaign.publicMessage);
    await sock.sendMessage(replyJid, {
      text: `Sent cleanup public notice to ${sentTargets.length}/${publicTargets.length} chat(s).`,
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

    const safeLimit = parsePositiveLimit(parts[2], 50, 200);
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

  if (subcommand === "dms" || subcommand === "dm") {
    const campaign = await getLatestOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    const maybeStatus = parts[2]?.toLowerCase();
    const status = ["sent", "failed", "pending", "all"].includes(maybeStatus ?? "")
      ? maybeStatus as "sent" | "failed" | "pending" | "all"
      : "sent";
    const limitToken = status === maybeStatus ? parts[3] : parts[2];
    const safeLimit = parsePositiveLimit(limitToken, 25, 200);
    const members = listCleanupDmMembers(campaign.id, status, safeLimit);
    await sock.sendMessage(replyJid, {
      text: formatCleanupDmMembers(
        `Cleanup DMs (${status}, ${members.length}${members.length === safeLimit ? "+" : ""})`,
        members,
      ),
    });
    return true;
  }

  if (subcommand === "remove-queue" || subcommand === "remove-jobs") {
    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, {
        text: "Only owners can view cleanup removal jobs.",
      });
      return true;
    }

    const maybeJobId = parts[2];
    if (maybeJobId && !/^\d+$/u.test(maybeJobId)) {
      const summary = getCleanupRemovalJobSummary(maybeJobId);
      if (!summary) {
        await sock.sendMessage(replyJid, { text: `Cleanup removal job not found: ${maybeJobId}` });
        return true;
      }
      const limit = parsePositiveLimit(parts[3], 50, 200);
      const actions = listCleanupRemovalJobActions(summary.job.id).slice(0, limit);
      const details = formatCleanupRemovalJobDetails(summary, actions, groups, limit);
      await sock.sendMessage(replyJid, { text: details.text, mentions: details.mentions });
      return true;
    }

    const limit = parsePositiveLimit(maybeJobId, 10, 25);
    const summaries = listCleanupRemovalJobSummaries(limit);
    await sock.sendMessage(replyJid, {
      text: formatRemovalJobSummaryList(`Cleanup removal queue (${summaries.length})`, summaries, groups),
    });
    return true;
  }

  if (subcommand === "remove-job") {
    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, {
        text: "Only owners can view cleanup removal jobs.",
      });
      return true;
    }

    const jobId = parts[2];
    if (!jobId) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup remove-job {jobId} {limit?}" });
      return true;
    }

    const summary = getCleanupRemovalJobSummary(jobId);
    if (!summary) {
      await sock.sendMessage(replyJid, { text: `Cleanup removal job not found: ${jobId}` });
      return true;
    }

    const limit = parsePositiveLimit(parts[3], 50, 200);
    const actions = listCleanupRemovalJobActions(summary.job.id).slice(0, limit);
    const details = formatCleanupRemovalJobDetails(summary, actions, groups, limit);
    await sock.sendMessage(replyJid, { text: details.text, mentions: details.mentions });
    return true;
  }

  if (subcommand === "remove-clear") {
    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, {
        text: "Only owners can clear cleanup removal jobs.",
      });
      return true;
    }

    const target = parts[2];
    const confirm = getOptionValue(parts.slice(3), "confirm");
    if (!target || confirm !== CLEANUP_REMOVE_CLEAR_CONFIRM_TOKEN) {
      await sock.sendMessage(replyJid, {
        text: [
          "Cleanup removal clear needs explicit confirmation.",
          `Usage: \`!cleanup remove-clear {jobId|all} confirm=${CLEANUP_REMOVE_CLEAR_CONFIRM_TOKEN}\``,
          "This cancels queued/running removal work only. It cannot undo removals already completed.",
        ].join("\n"),
      });
      return true;
    }

    const reason = `cancelled by ${actor.label}`;
    let summaries: CleanupRemovalJobSummary[];
    if (target.toLowerCase() === "all") {
      summaries = cancelAllUnfinishedCleanupRemovalJobs(reason);
    } else {
      const job = getCleanupRemovalJob(target);
      if (!job) {
        await sock.sendMessage(replyJid, { text: `Cleanup removal job not found: ${target}` });
        return true;
      }
      if (job.status !== "queued" && job.status !== "running") {
        await sock.sendMessage(replyJid, {
          text: `Cleanup removal job ${target} is already ${job.status}; only queued/running jobs can be cleared.`,
        });
        return true;
      }
      summaries = [cancelCleanupRemovalJob(target, reason)].filter((summary): summary is CleanupRemovalJobSummary => Boolean(summary));
    }
    if (summaries.length === 0) {
      await sock.sendMessage(replyJid, {
        text: "No queued or running cleanup removal jobs to clear.",
      });
      return true;
    }

    await sock.sendMessage(replyJid, {
      text: [
        `Cleared ${summaries.length} cleanup removal job(s).`,
        ...summaries.map((summary) =>
          `${shortJobId(summary.job.id)} — ${summary.job.status}, ${formatRemovalJobProgress(summary)}`),
        "",
        "Completed removals are unchanged. Pending/running removals were marked skipped.",
      ].join("\n"),
    });
    return true;
  }

  if (subcommand === "remove-preview" || subcommand === "remove-start") {
    const campaign = await getLatestOrReply(sock, replyJid);
    if (!campaign) {
      return true;
    }

    if (actor.role !== "owner") {
      await sock.sendMessage(replyJid, {
        text: "Only owners can bulk-remove cleanup candidates.",
      });
      return true;
    }

    const optionTokens = parts.slice(2);
    const { groupJids, error } = getRemovalTargetGroupJids(config, groups, optionTokens);
    if (error) {
      await sock.sendMessage(replyJid, { text: error });
      return true;
    }

    const limit = parseCleanupRemoveLimit(optionTokens);
    const plan = buildCleanupRemovalPlan(campaign.id, groupJids, limit, config, groupMetadataByJid, selfJids);
    const removablePeople = countCleanupRemovablePeople(plan);
    const removalActions = countCleanupRemovalActions(plan);
    const blockedGroups = countCleanupBlockedGroups(plan);
    const scope = formatRemovalScope(groupJids, groups);

    if (subcommand === "remove-preview") {
      const preview = formatCleanupRemovalPlan(
        `Cleanup removal preview (${removablePeople}/${limit} people, ${removalActions} removals, ${plan.length} shown, ${scope}${blockedGroups > 0 ? `, ${blockedGroups} blocked` : ""})`,
        plan,
        groups,
      );
      await sock.sendMessage(replyJid, {
        text: [
          preview.text,
          "",
          "Selection: non-whitelisted cleanup candidates, oldest-known identity first. WhatsApp join time is not stored, so this is deterministic rather than random.",
          `To run: \`!cleanup remove-start ${limit} ${groupJids.length === 1 ? `group=${groupJids[0]}` : "all=true"} confirm=${CLEANUP_REMOVE_CONFIRM_TOKEN}\``,
        ].join("\n"),
        mentions: preview.mentions,
      });
      return true;
    }

    const confirm = getOptionValue(optionTokens, "confirm");
    if (confirm !== CLEANUP_REMOVE_CONFIRM_TOKEN) {
      await sock.sendMessage(replyJid, {
        text: [
          "Cleanup removal needs explicit confirmation.",
          `Preview first with \`!cleanup remove-preview ${limit} ${groupJids.length === 1 ? `group=${groupJids[0]}` : "all=true"}\`.`,
          `Then run with \`confirm=${CLEANUP_REMOVE_CONFIRM_TOKEN}\`.`,
          "This only removes members from chats. It does not ban them.",
        ].join("\n"),
      });
      return true;
    }

    if (removalActions === 0) {
      const preview = formatCleanupRemovalPlan(
        `Cleanup removal blocked (${plan.length} candidate(s), ${scope}${blockedGroups > 0 ? `, ${blockedGroups} blocked` : ""})`,
        plan,
        groups,
      );
      await sock.sendMessage(replyJid, {
        text: [
          preview.text,
          "",
          blockedGroups > 0
            ? "No removals started because the bot is not admin in the listed chat(s)."
            : "No removable non-whitelisted cleanup candidates found in the selected chat scope.",
        ].join("\n"),
        mentions: preview.mentions,
      });
      return true;
    }

    const delayMs = delayMsFromToken(getOptionValue(optionTokens, "delay") ?? undefined, CLEANUP_REMOVE_DEFAULT_DELAY_MS);
    const groupDelayMs = delayMsFromToken(
      getOptionValue(optionTokens, "group-delay") ?? undefined,
      CLEANUP_REMOVE_DEFAULT_GROUP_DELAY_MS,
      CLEANUP_REMOVE_MIN_GROUP_DELAY_MS,
    );
    if (!delayMs || !groupDelayMs) {
      await sock.sendMessage(replyJid, {
        text: "Usage: !cleanup remove-start {limit?} group={groupJid}|all=true confirm=REMOVE [delay=10s] [group-delay=60s]",
      });
      return true;
    }

    const delayText = groupJids.length === 1
      ? `Delay: ${Math.round(delayMs / 1000)}s between removals in the chat.`
      : `Delay: ${Math.round(delayMs / 1000)}s between removals in the same chat; ${Math.round(groupDelayMs / 1000)}s cooldown before switching chats.`;
    if (cleanupRemovalJobInFlight) {
      await sock.sendMessage(replyJid, {
        text: `Cleanup removal job ${cleanupRemovalJobInFlight} is already running. Wait for it to finish before starting another removal batch.`,
      });
      return true;
    }

    const orderedActions = groupCleanupRemovalActions(plan, groupJids)
      .flatMap((group) => group.actions.map((action) => ({
        userId: action.member.userId,
        displayName: action.member.displayName,
        groupJid: action.removal.groupJid,
        participantJid: action.removal.participantJid,
      })));
    const job = createCleanupRemovalJob({
      campaignId: campaign.id,
      groupJids,
      peopleLimit: limit,
      delayMs,
      groupDelayMs,
      totalPeople: removablePeople,
      createdByUserId: actor.userId,
      createdByLabel: actor.label,
      replyJid,
      actions: orderedActions,
    });

    await sock.sendMessage(replyJid, {
      text: [
        `Starting cleanup removal for ${pluralize(removablePeople, "person", "people")} (${pluralize(removalActions, "participant removal")}) in ${scope}.`,
        `Job: ${job.id}`,
        "Execution: grouped by chat.",
        delayText,
        "Queue is persisted; if the bot restarts, pending removals resume after reconnect.",
        "This removes only; it does not ban.",
      ].join("\n"),
    });

    const result = await runCleanupRemovalJob(sock, job.id, config, groupMetadataByJid, selfJids);
    await sock.sendMessage(replyJid, {
      text: [
        "Cleanup removal batch complete.",
        `Job: ${job.id}`,
        `Removed: ${result.succeeded}`,
        `Failed: ${result.failed}`,
        result.skipped > 0 ? `Skipped: ${result.skipped}` : null,
        "Run `!cleanup candidates 100` or another `!cleanup remove-preview` before the next batch.",
      ].filter(Boolean).join("\n"),
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

  if (subcommand === "unkeep") {
    const campaign = await getActiveOrReply(sock, replyJid);
    const identifier = parts[2];
    if (!campaign || !identifier) {
      await sock.sendMessage(replyJid, { text: "Usage: !cleanup unkeep {userId|phone|jid}" });
      return true;
    }

    const member = findCleanupMemberByUserOrJid(campaign.id, getManualKeepIdentifiers(identifier));
    if (!member) {
      await sock.sendMessage(replyJid, {
        text: `Couldn't find ${formatJidForDisplay(identifier)} in the active cleanup campaign. Use \`!cleanup whitelist 100\` or \`!cleanup candidates 100\` to confirm the exact entry.`,
      });
      return true;
    }

    const label = member.displayName ?? formatJidForDisplay(member.primaryJid);
    if (member.whitelistReason === "protected") {
      await sock.sendMessage(replyJid, {
        text: `${label} is protected and cannot be removed from the cleanup whitelist.`,
      });
      return true;
    }

    if (!member.whitelistedAt) {
      await sock.sendMessage(replyJid, { text: `${label} is not whitelisted.` });
      return true;
    }

    const removed = removeCleanupWhitelist(campaign.id, member.userId);
    await sock.sendMessage(replyJid, {
      text: removed ? `Removed ${label} from the cleanup whitelist.` : `Couldn't remove ${label} from the cleanup whitelist.`,
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
    const suggestions: string[] = [];
    const seenUserIds = new Set<string>();
    const campaignMembers = listCleanupMembers(campaign.id);

    for (const identifier of identifiers.slice(0, 200)) {
      const member = findCleanupMemberByUserOrJid(campaign.id, getManualKeepIdentifiers(identifier));
      if (!member) {
        notFound.push(identifier);
        const nearby = getNearbyMemberSuggestions(identifier, campaignMembers);
        if (nearby.length > 0 && suggestions.length < 8) {
          suggestions.push(`${identifier} -> did you mean ${nearby.join(" or ")}?`);
        }
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
        suggestions.length > 0 ? `Suggestions:\n${suggestions.join("\n")}` : null,
      ].filter(Boolean).join("\n"),
    });
    return true;
  }

  await sock.sendMessage(replyJid, { text: CLEANUP_HELP });
  return true;
};
