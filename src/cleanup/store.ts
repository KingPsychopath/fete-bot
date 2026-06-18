import { randomUUID } from "node:crypto";

import { assertUserWritable, getDb, withImmediateTransaction } from "../db.js";
import { CLEANUP_DM_RATE_LIMIT } from "./policy.js";

export type CleanupCampaignStatus = "active" | "paused" | "completed" | "stopped";
export type CleanupSignalType =
  | "public_reaction"
  | "public_reply"
  | "group_activity"
  | "dm_reaction"
  | "dm_reply"
  | "manual"
  | "protected";
export type CleanupDmStatus = "pending" | "sent" | "failed" | "skipped";
export type CleanupRemovalJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled";
export type CleanupRemovalActionStatus = "pending" | "running" | "succeeded" | "failed" | "skipped";

export type CleanupCampaign = {
  id: string;
  status: CleanupCampaignStatus;
  startedAt: number;
  endsAt: number;
  createdByUserId: string | null;
  createdByLabel: string;
  channelLink: string | null;
  publicMessage: string;
  dmMessage: string;
  batchSize: number;
  batchIntervalMinutes: number;
  nextBatchNotBefore: number | null;
  lastBatchSentAt: number | null;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
  stoppedAt: number | null;
};

export type CleanupMember = {
  campaignId: string;
  userId: string;
  displayName: string | null;
  primaryJid: string;
  firstSeenGroupJid: string | null;
  whitelistedAt: number | null;
  whitelistReason: CleanupSignalType | null;
  lastSignalAt: number | null;
  dmStatus: CleanupDmStatus;
  dmSentAt: number | null;
  dmError: string | null;
  createdAt: number;
  updatedAt: number;
};

export type CleanupRemovalJob = {
  id: string;
  campaignId: string;
  status: CleanupRemovalJobStatus;
  scopeGroupJids: string[];
  peopleLimit: number;
  delayMs: number;
  groupDelayMs: number;
  totalPeople: number;
  totalActions: number;
  createdByUserId: string | null;
  createdByLabel: string;
  replyJid: string;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
  lastError: string | null;
};

export type CleanupRemovalAction = {
  id: string;
  jobId: string;
  campaignId: string;
  actionOrder: number;
  userId: string;
  displayName: string | null;
  groupJid: string;
  participantJid: string;
  status: CleanupRemovalActionStatus;
  attemptCount: number;
  lastStatus: string | null;
  lastError: string | null;
  createdAt: number;
  startedAt: number | null;
  updatedAt: number;
  completedAt: number | null;
};

export type CleanupRemovalJobSummary = {
  job: CleanupRemovalJob;
  pending: number;
  running: number;
  succeeded: number;
  failed: number;
  skipped: number;
};

export type CleanupMemberSeed = {
  userId: string;
  displayName?: string | null;
  primaryJid: string;
  firstSeenGroupJid?: string | null;
  protected?: boolean;
  whitelisted?: boolean;
  whitelistReason?: CleanupSignalType;
};

export type CleanupCampaignCreateInput = {
  durationMs: number;
  actorUserId: string | null;
  actorLabel: string;
  channelLink: string | null;
  publicMessage: string;
  dmMessage: string;
  batchSize: number;
  batchIntervalMinutes: number;
  members: CleanupMemberSeed[];
  nowMs?: number;
};

export type CleanupStats = {
  campaign: CleanupCampaign;
  total: number;
  whitelisted: number;
  noSignal: number;
  purgeCandidates: number;
  dmPending: number;
  dmAwaitingDelivery: number;
  dmSent: number;
  dmFailed: number;
  dmSkipped: number;
  nextBatchSize: number;
  nextBatchAt: number | null;
  signals: Record<CleanupSignalType, number>;
};

type CampaignRow = {
  id: string;
  status: CleanupCampaignStatus;
  started_at: number;
  ends_at: number;
  created_by_user_id: string | null;
  created_by_label: string;
  channel_link: string | null;
  public_message: string;
  dm_message: string;
  batch_size: number;
  batch_interval_minutes: number;
  next_batch_not_before: number | null;
  last_batch_sent_at: number | null;
  created_at: number;
  updated_at: number;
  completed_at: number | null;
  stopped_at: number | null;
};

type MemberRow = {
  campaign_id: string;
  user_id: string;
  display_name: string | null;
  primary_jid: string;
  first_seen_group_jid: string | null;
  whitelisted_at: number | null;
  whitelist_reason: CleanupSignalType | null;
  last_signal_at: number | null;
  dm_status: CleanupDmStatus;
  dm_sent_at: number | null;
  dm_error: string | null;
  created_at: number;
  updated_at: number;
};

type RemovalJobRow = {
  id: string;
  campaign_id: string;
  status: CleanupRemovalJobStatus;
  scope_group_jids_json: string;
  people_limit: number;
  delay_ms: number;
  group_delay_ms: number;
  total_people: number;
  total_actions: number;
  created_by_user_id: string | null;
  created_by_label: string;
  reply_jid: string;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
  last_error: string | null;
};

type RemovalActionRow = {
  id: string;
  job_id: string;
  campaign_id: string;
  action_order: number;
  user_id: string;
  display_name: string | null;
  group_jid: string;
  participant_jid: string;
  status: CleanupRemovalActionStatus;
  attempt_count: number;
  last_status: string | null;
  last_error: string | null;
  created_at: number;
  started_at: number | null;
  updated_at: number;
  completed_at: number | null;
};

const toCampaign = (row: CampaignRow): CleanupCampaign => ({
  id: row.id,
  status: row.status,
  startedAt: row.started_at,
  endsAt: row.ends_at,
  createdByUserId: row.created_by_user_id,
  createdByLabel: row.created_by_label,
  channelLink: row.channel_link,
  publicMessage: row.public_message,
  dmMessage: row.dm_message,
  batchSize: row.batch_size,
  batchIntervalMinutes: row.batch_interval_minutes,
  nextBatchNotBefore: row.next_batch_not_before,
  lastBatchSentAt: row.last_batch_sent_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  stoppedAt: row.stopped_at,
});

const toMember = (row: MemberRow): CleanupMember => ({
  campaignId: row.campaign_id,
  userId: row.user_id,
  displayName: row.display_name,
  primaryJid: row.primary_jid,
  firstSeenGroupJid: row.first_seen_group_jid,
  whitelistedAt: row.whitelisted_at,
  whitelistReason: row.whitelist_reason,
  lastSignalAt: row.last_signal_at,
  dmStatus: row.dm_status,
  dmSentAt: row.dm_sent_at,
  dmError: row.dm_error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

const parseGroupJids = (json: string): string[] => {
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
};

const toRemovalJob = (row: RemovalJobRow): CleanupRemovalJob => ({
  id: row.id,
  campaignId: row.campaign_id,
  status: row.status,
  scopeGroupJids: parseGroupJids(row.scope_group_jids_json),
  peopleLimit: row.people_limit,
  delayMs: row.delay_ms,
  groupDelayMs: row.group_delay_ms,
  totalPeople: row.total_people,
  totalActions: row.total_actions,
  createdByUserId: row.created_by_user_id,
  createdByLabel: row.created_by_label,
  replyJid: row.reply_jid,
  createdAt: row.created_at,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  lastError: row.last_error,
});

const toRemovalAction = (row: RemovalActionRow): CleanupRemovalAction => ({
  id: row.id,
  jobId: row.job_id,
  campaignId: row.campaign_id,
  actionOrder: row.action_order,
  userId: row.user_id,
  displayName: row.display_name,
  groupJid: row.group_jid,
  participantJid: row.participant_jid,
  status: row.status,
  attemptCount: row.attempt_count,
  lastStatus: row.last_status,
  lastError: row.last_error,
  createdAt: row.created_at,
  startedAt: row.started_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
});

export const getOpenCleanupCampaign = (): CleanupCampaign | null => {
  const row = getDb()
    .prepare<[], CampaignRow>(`
      SELECT *
      FROM cleanup_campaigns
      WHERE status IN ('active','paused')
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .get();
  return row ? toCampaign(row) : null;
};

export const getCleanupCampaign = (id: string): CleanupCampaign | null => {
  const row = getDb()
    .prepare<[string], CampaignRow>("SELECT * FROM cleanup_campaigns WHERE id = ?")
    .get(id);
  return row ? toCampaign(row) : null;
};

export const continueLatestCleanupCampaignPaused = (
  durationMs: number,
  nowMs = Date.now(),
): CleanupCampaign | null => withImmediateTransaction(() => {
  const existingOpen = getOpenCleanupCampaign();
  if (existingOpen) {
    return existingOpen;
  }

  const latest = getLatestCleanupCampaign();
  if (!latest) {
    return null;
  }

  getDb()
    .prepare(`
      UPDATE cleanup_campaigns
      SET
        status = 'paused',
        ends_at = ?,
        next_batch_not_before = ?,
        completed_at = NULL,
        stopped_at = NULL,
        updated_at = ?
      WHERE id = ?
    `)
    .run(nowMs + durationMs, nowMs, nowMs, latest.id);

  return getCleanupCampaign(latest.id);
});

export const getLatestCleanupCampaign = (): CleanupCampaign | null => {
  const row = getDb()
    .prepare<[], CampaignRow>(`
      SELECT *
      FROM cleanup_campaigns
      ORDER BY started_at DESC
      LIMIT 1
    `)
    .get();
  return row ? toCampaign(row) : null;
};

export const createCleanupCampaign = (input: CleanupCampaignCreateInput): CleanupCampaign => {
  const nowMs = input.nowMs ?? Date.now();
  const id = randomUUID();
  const uniqueMembers = new Map<string, CleanupMemberSeed>();
  for (const member of input.members) {
    uniqueMembers.set(assertUserWritable(member.userId), member);
  }

  return withImmediateTransaction(() => {
    const existing = getOpenCleanupCampaign();
    if (existing) {
      throw new Error(`Cleanup campaign ${existing.id} is already ${existing.status}`);
    }

    getDb()
      .prepare(`
        INSERT INTO cleanup_campaigns (
          id,
          status,
          started_at,
          ends_at,
          created_by_user_id,
          created_by_label,
          channel_link,
          public_message,
          dm_message,
          batch_size,
          batch_interval_minutes,
          next_batch_not_before,
          created_at,
          updated_at
        ) VALUES (?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        id,
        nowMs,
        nowMs + input.durationMs,
        input.actorUserId,
        input.actorLabel,
        input.channelLink,
        input.publicMessage,
        input.dmMessage,
        input.batchSize,
        input.batchIntervalMinutes,
        nowMs,
        nowMs,
        nowMs,
      );

    const insertMember = getDb().prepare(`
      INSERT INTO cleanup_members (
        campaign_id,
        user_id,
        display_name,
        primary_jid,
        first_seen_group_jid,
        whitelisted_at,
        whitelist_reason,
        last_signal_at,
        dm_status,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    for (const member of uniqueMembers.values()) {
      const isProtected = Boolean(member.protected);
      const isWhitelisted = isProtected || Boolean(member.whitelisted);
      const whitelistReason = isProtected ? "protected" : member.whitelistReason ?? "manual";
      insertMember.run(
        id,
        member.userId,
        member.displayName ?? null,
        member.primaryJid,
        member.firstSeenGroupJid ?? null,
        isWhitelisted ? nowMs : null,
        isWhitelisted ? whitelistReason : null,
        isWhitelisted ? nowMs : null,
        isWhitelisted ? "skipped" : "pending",
        nowMs,
        nowMs,
      );

      if (isWhitelisted) {
        recordCleanupSignal(id, member.userId, whitelistReason, member.firstSeenGroupJid ?? null, null, nowMs);
      }
    }

    return getCleanupCampaign(id)!;
  });
};

export const recordCleanupMessage = (
  campaignId: string,
  destinationJid: string,
  messageId: string | null | undefined,
  messageType: "public" | "dm",
  userId: string | null,
  sentAt = Date.now(),
): void => {
  if (!messageId) {
    return;
  }

  getDb()
    .prepare(`
      INSERT OR IGNORE INTO cleanup_messages (
        campaign_id,
        destination_jid,
        message_id,
        message_type,
        user_id,
        sent_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(campaignId, destinationJid, messageId, messageType, userId, sentAt);
};

export const findCleanupMessage = (
  destinationJid: string,
  messageId: string | null | undefined,
): { campaignId: string; messageType: "public" | "dm"; userId: string | null } | null => {
  if (!messageId) {
    return null;
  }

  const row = getDb()
    .prepare<
      [string, string],
      { campaign_id: string; message_type: "public" | "dm"; user_id: string | null }
    >(`
      SELECT campaign_id, message_type, user_id
      FROM cleanup_messages
      WHERE destination_jid = ? AND message_id = ?
      LIMIT 1
    `)
    .get(destinationJid, messageId);

  return row ? { campaignId: row.campaign_id, messageType: row.message_type, userId: row.user_id } : null;
};

export const findCleanupMessageByMessageId = (
  messageId: string | null | undefined,
): { campaignId: string; destinationJid: string; messageType: "public" | "dm"; userId: string | null } | null => {
  if (!messageId) {
    return null;
  }

  const row = getDb()
    .prepare<
      [string],
      { campaign_id: string; destination_jid: string; message_type: "public" | "dm"; user_id: string | null }
    >(`
      SELECT campaign_id, destination_jid, message_type, user_id
      FROM cleanup_messages
      WHERE message_id = ?
      ORDER BY sent_at DESC
      LIMIT 1
    `)
    .get(messageId);

  return row
    ? {
        campaignId: row.campaign_id,
        destinationJid: row.destination_jid,
        messageType: row.message_type,
        userId: row.user_id,
      }
    : null;
};

export const recordCleanupSignal = (
  campaignId: string,
  userId: string,
  signalType: CleanupSignalType,
  sourceJid: string | null,
  messageId: string | null,
  nowMs = Date.now(),
): boolean => {
  const writableUserId = assertUserWritable(userId);
  return withImmediateTransaction(() => {
    const memberExists = Boolean(
      getDb()
        .prepare<[string, string], { user_id: string }>(`
          SELECT user_id
          FROM cleanup_members
          WHERE campaign_id = ? AND user_id = ?
        `)
        .get(campaignId, writableUserId),
    );
    if (!memberExists) {
      return false;
    }

    const inserted = getDb()
      .prepare(`
        INSERT OR IGNORE INTO cleanup_signals (
          campaign_id,
          user_id,
          signal_type,
          source_jid,
          message_id,
          created_at
        ) VALUES (?, ?, ?, ?, ?, ?)
      `)
      .run(campaignId, writableUserId, signalType, sourceJid, messageId, nowMs).changes > 0;

    getDb()
      .prepare(`
        UPDATE cleanup_members
        SET
          whitelisted_at = COALESCE(whitelisted_at, ?),
          whitelist_reason = COALESCE(whitelist_reason, ?),
          dm_status = CASE WHEN dm_status = 'pending' THEN 'skipped' ELSE dm_status END,
          last_signal_at = ?,
          updated_at = ?
        WHERE campaign_id = ? AND user_id = ?
      `)
      .run(nowMs, signalType, nowMs, nowMs, campaignId, writableUserId);

    return inserted;
  });
};

export const recordCleanupSignalForOpenCampaign = (
  userId: string,
  signalType: CleanupSignalType,
  sourceJid: string | null,
  messageId: string | null,
  nowMs = Date.now(),
): { recorded: boolean; firstWhitelist: boolean; campaign: CleanupCampaign | null } => {
  const campaign = getOpenCleanupCampaign();
  if (!campaign || nowMs > campaign.endsAt) {
    return { recorded: false, firstWhitelist: false, campaign: null };
  }

  const memberBefore = getDb()
    .prepare<[string, string], { whitelisted_at: number | null }>(`
      SELECT whitelisted_at
      FROM cleanup_members
      WHERE campaign_id = ? AND user_id = ?
    `)
    .get(campaign.id, assertUserWritable(userId));
  const recorded = recordCleanupSignal(campaign.id, userId, signalType, sourceJid, messageId, nowMs);
  return {
    recorded,
    firstWhitelist: Boolean(memberBefore && memberBefore.whitelisted_at === null),
    campaign,
  };
};

export const removeCleanupWhitelist = (
  campaignId: string,
  userId: string,
  nowMs = Date.now(),
): boolean => {
  const result = getDb()
    .prepare(`
      UPDATE cleanup_members
      SET
        whitelisted_at = NULL,
        whitelist_reason = NULL,
        dm_status = CASE WHEN dm_status = 'skipped' THEN 'pending' ELSE dm_status END,
        updated_at = ?
      WHERE campaign_id = ? AND user_id = ? AND whitelisted_at IS NOT NULL
    `)
    .run(nowMs, campaignId, assertUserWritable(userId));
  return result.changes > 0;
};

export const listCleanupMembersForDmBatch = (
  campaignId: string,
  limit: number,
): CleanupMember[] =>
  getDb()
    .prepare<[string, number], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ?
        AND whitelisted_at IS NULL
        AND dm_status = 'pending'
        AND NOT EXISTS (
          SELECT 1
          FROM cleanup_messages
          WHERE cleanup_messages.campaign_id = cleanup_members.campaign_id
            AND cleanup_messages.user_id = cleanup_members.user_id
            AND cleanup_messages.message_type = 'dm'
        )
      ORDER BY created_at ASC, user_id ASC
      LIMIT ?
    `)
    .all(campaignId, Math.max(0, Math.trunc(limit)))
    .map(toMember);

export const markCleanupDmSent = (
  campaignId: string,
  userId: string,
  sentAt = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_members
      SET dm_status = 'sent', dm_sent_at = ?, dm_error = NULL, updated_at = ?
      WHERE campaign_id = ? AND user_id = ?
    `)
    .run(sentAt, sentAt, campaignId, assertUserWritable(userId));
};

export const markCleanupDmDeliveredByMessageId = (
  messageId: string | null | undefined,
  deliveredAt = Date.now(),
): { campaignId: string; destinationJid: string; userId: string; markedSent: boolean } | null => {
  const cleanupMessage = findCleanupMessageByMessageId(messageId);
  if (!cleanupMessage || cleanupMessage.messageType !== "dm" || !cleanupMessage.userId) {
    return null;
  }

  const member = getDb()
    .prepare<[string, string], { whitelisted_at: number | null }>(`
      SELECT whitelisted_at
      FROM cleanup_members
      WHERE campaign_id = ? AND user_id = ?
      LIMIT 1
    `)
    .get(cleanupMessage.campaignId, cleanupMessage.userId);
  if (!member) {
    return null;
  }

  if (member.whitelisted_at !== null) {
    return {
      campaignId: cleanupMessage.campaignId,
      destinationJid: cleanupMessage.destinationJid,
      userId: cleanupMessage.userId,
      markedSent: false,
    };
  }

  markCleanupDmSent(cleanupMessage.campaignId, cleanupMessage.userId, deliveredAt);
  return {
    campaignId: cleanupMessage.campaignId,
    destinationJid: cleanupMessage.destinationJid,
    userId: cleanupMessage.userId,
    markedSent: true,
  };
};

export const markCleanupDmFailed = (
  campaignId: string,
  userId: string,
  error: string,
  failedAt = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_members
      SET dm_status = 'failed', dm_error = ?, updated_at = ?
      WHERE campaign_id = ? AND user_id = ?
    `)
    .run(error.slice(0, 500), failedAt, campaignId, assertUserWritable(userId));
};

export const markCleanupBatchSent = (
  campaignId: string,
  nextBatchNotBefore: number,
  sentAt = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_campaigns
      SET last_batch_sent_at = ?, next_batch_not_before = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(sentAt, nextBatchNotBefore, sentAt, campaignId);
};

export const setCleanupCampaignStatus = (
  campaignId: string,
  status: CleanupCampaignStatus,
  nowMs = Date.now(),
): CleanupCampaign | null => {
  const completedAt = status === "completed" ? nowMs : null;
  const stoppedAt = status === "stopped" ? nowMs : null;
  getDb()
    .prepare(`
      UPDATE cleanup_campaigns
      SET status = ?, updated_at = ?, completed_at = COALESCE(completed_at, ?), stopped_at = COALESCE(stopped_at, ?)
      WHERE id = ?
    `)
    .run(status, nowMs, completedAt, stoppedAt, campaignId);
  return getCleanupCampaign(campaignId);
};

export const extendCleanupCampaign = (
  campaignId: string,
  extensionMs: number,
  nowMs = Date.now(),
): CleanupCampaign | null => {
  getDb()
    .prepare(`
      UPDATE cleanup_campaigns
      SET ends_at = ends_at + ?, updated_at = ?
      WHERE id = ? AND status IN ('active','paused')
    `)
    .run(extensionMs, nowMs, campaignId);
  return getCleanupCampaign(campaignId);
};

export const getCleanupStats = (campaignId: string): CleanupStats | null => {
  const campaign = getCleanupCampaign(campaignId);
  if (!campaign) {
    return null;
  }

  const counts = getDb()
    .prepare<
      [string],
      {
        total: number;
        whitelisted: number;
        dm_pending: number;
        dm_sent: number;
        dm_failed: number;
        dm_skipped: number;
      }
    >(`
      SELECT
        COUNT(*) AS total,
        SUM(CASE WHEN whitelisted_at IS NOT NULL THEN 1 ELSE 0 END) AS whitelisted,
        SUM(CASE WHEN dm_status = 'pending' THEN 1 ELSE 0 END) AS dm_pending,
        SUM(CASE WHEN dm_status = 'sent' THEN 1 ELSE 0 END) AS dm_sent,
        SUM(CASE WHEN dm_status = 'failed' THEN 1 ELSE 0 END) AS dm_failed,
        SUM(CASE WHEN dm_status = 'skipped' THEN 1 ELSE 0 END) AS dm_skipped
      FROM cleanup_members
      WHERE campaign_id = ?
    `)
    .get(campaignId);

  const signalCounts = getDb()
    .prepare<[string], { signal_type: CleanupSignalType; count: number }>(`
      SELECT signal_type, COUNT(*) AS count
      FROM cleanup_signals
      WHERE campaign_id = ?
      GROUP BY signal_type
    `)
    .all(campaignId);

  const signals: Record<CleanupSignalType, number> = {
    public_reaction: 0,
    public_reply: 0,
    group_activity: 0,
    dm_reaction: 0,
    dm_reply: 0,
    manual: 0,
    protected: 0,
  };
  for (const row of signalCounts) {
    signals[row.signal_type] = row.count;
  }

  const total = counts?.total ?? 0;
  const whitelisted = counts?.whitelisted ?? 0;
  const dmPending = counts?.dm_pending ?? 0;
  const dmAwaitingDelivery = getDb()
    .prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM cleanup_members
      WHERE campaign_id = ?
        AND whitelisted_at IS NULL
        AND dm_status = 'pending'
        AND EXISTS (
          SELECT 1
          FROM cleanup_messages
          WHERE cleanup_messages.campaign_id = cleanup_members.campaign_id
            AND cleanup_messages.user_id = cleanup_members.user_id
            AND cleanup_messages.message_type = 'dm'
        )
    `)
    .get(campaignId)?.count ?? 0;
  const dmEligibleForBatch = Math.max(0, dmPending - dmAwaitingDelivery);
  const nextBatchSize = campaign.status === "active"
    ? Math.min(CLEANUP_DM_RATE_LIMIT.messagesPerWindow, dmEligibleForBatch)
    : 0;

  return {
    campaign,
    total,
    whitelisted,
    noSignal: Math.max(0, total - whitelisted),
    purgeCandidates: Math.max(0, total - whitelisted),
    dmPending,
    dmAwaitingDelivery,
    dmSent: counts?.dm_sent ?? 0,
    dmFailed: counts?.dm_failed ?? 0,
    dmSkipped: counts?.dm_skipped ?? 0,
    nextBatchSize,
    nextBatchAt: nextBatchSize > 0 ? campaign.nextBatchNotBefore : null,
    signals,
  };
};

export const listCleanupWhitelistedMembers = (
  campaignId: string,
  limit: number,
): CleanupMember[] =>
  getDb()
    .prepare<[string, number], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ? AND whitelisted_at IS NOT NULL
      ORDER BY whitelisted_at DESC, updated_at DESC
      LIMIT ?
    `)
    .all(campaignId, Math.min(Math.max(Math.trunc(limit), 1), 500))
    .map(toMember);

export const listCleanupCandidateMembers = (
  campaignId: string,
  limit: number,
): CleanupMember[] =>
  getDb()
    .prepare<[string, number], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ? AND whitelisted_at IS NULL
      ORDER BY dm_sent_at IS NULL ASC, dm_sent_at ASC, created_at ASC
      LIMIT ?
    `)
    .all(campaignId, Math.min(Math.max(Math.trunc(limit), 1), 500))
    .map(toMember);

export const listCleanupRemovalCandidateMembers = (
  campaignId: string,
  limit: number,
): CleanupMember[] =>
  getDb()
    .prepare<[string, number], MemberRow>(`
      SELECT cleanup_members.*
      FROM cleanup_members
      LEFT JOIN users ON users.id = cleanup_members.user_id
      WHERE cleanup_members.campaign_id = ?
        AND cleanup_members.whitelisted_at IS NULL
      ORDER BY
        COALESCE(users.created_at, cleanup_members.created_at) ASC,
        cleanup_members.created_at ASC,
        cleanup_members.user_id ASC
      LIMIT ?
    `)
    .all(campaignId, Math.min(Math.max(Math.trunc(limit), 1), 5_000))
    .map(toMember);

export const getCleanupMember = (
  campaignId: string,
  userId: string,
): CleanupMember | null => {
  const row = getDb()
    .prepare<[string, string], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ? AND user_id = ?
      LIMIT 1
    `)
    .get(campaignId, assertUserWritable(userId));
  return row ? toMember(row) : null;
};

export const createCleanupRemovalJob = (input: {
  campaignId: string;
  groupJids: readonly string[];
  peopleLimit: number;
  delayMs: number;
  groupDelayMs: number;
  totalPeople: number;
  createdByUserId: string | null;
  createdByLabel: string;
  replyJid: string;
  actions: readonly {
    userId: string;
    displayName: string | null;
    groupJid: string;
    participantJid: string;
  }[];
  nowMs?: number;
}): CleanupRemovalJob => withImmediateTransaction(() => {
  const nowMs = input.nowMs ?? Date.now();
  const jobId = randomUUID();

  getDb()
    .prepare(`
      INSERT INTO cleanup_removal_jobs (
        id,
        campaign_id,
        status,
        scope_group_jids_json,
        people_limit,
        delay_ms,
        group_delay_ms,
        total_people,
        total_actions,
        created_by_user_id,
        created_by_label,
        reply_jid,
        created_at,
        updated_at
      ) VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      jobId,
      input.campaignId,
      JSON.stringify(Array.from(input.groupJids)),
      Math.max(1, Math.trunc(input.peopleLimit)),
      Math.max(0, Math.trunc(input.delayMs)),
      Math.max(0, Math.trunc(input.groupDelayMs)),
      Math.max(0, Math.trunc(input.totalPeople)),
      input.actions.length,
      input.createdByUserId,
      input.createdByLabel,
      input.replyJid,
      nowMs,
      nowMs,
    );

  const insertAction = getDb().prepare(`
    INSERT INTO cleanup_removal_actions (
      id,
      job_id,
      campaign_id,
      action_order,
      user_id,
      display_name,
      group_jid,
      participant_jid,
      status,
      created_at,
      updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
  `);

  for (const [index, action] of input.actions.entries()) {
    insertAction.run(
      randomUUID(),
      jobId,
      input.campaignId,
      index + 1,
      assertUserWritable(action.userId),
      action.displayName,
      action.groupJid,
      action.participantJid,
      nowMs,
      nowMs,
    );
  }

  return getCleanupRemovalJob(jobId)!;
});

export const getCleanupRemovalJob = (jobId: string): CleanupRemovalJob | null => {
  const row = getDb()
    .prepare<[string], RemovalJobRow>("SELECT * FROM cleanup_removal_jobs WHERE id = ?")
    .get(jobId);
  return row ? toRemovalJob(row) : null;
};

export const claimCleanupRemovalJob = (
  jobId: string,
  nowMs = Date.now(),
): CleanupRemovalJob | null => withImmediateTransaction(() => {
  const row = getDb()
    .prepare<[string], RemovalJobRow>(`
      SELECT *
      FROM cleanup_removal_jobs
      WHERE id = ? AND status IN ('queued','running')
      LIMIT 1
    `)
    .get(jobId);
  if (!row) {
    return null;
  }

  getDb()
    .prepare(`
      UPDATE cleanup_removal_jobs
      SET status = 'running',
          started_at = COALESCE(started_at, ?),
          updated_at = ?,
          last_error = NULL
      WHERE id = ?
    `)
    .run(nowMs, nowMs, jobId);

  getDb()
    .prepare(`
      UPDATE cleanup_removal_actions
      SET status = 'pending',
          updated_at = ?,
          last_error = COALESCE(last_error, 'interrupted before completion')
      WHERE job_id = ? AND status = 'running'
    `)
    .run(nowMs, jobId);

  return getCleanupRemovalJob(jobId);
});

export const listUnfinishedCleanupRemovalJobs = (limit = 5): CleanupRemovalJob[] =>
  getDb()
    .prepare<[number], RemovalJobRow>(`
      SELECT *
      FROM cleanup_removal_jobs
      WHERE status IN ('queued','running')
      ORDER BY created_at ASC
      LIMIT ?
    `)
    .all(Math.min(Math.max(Math.trunc(limit), 1), 25))
    .map(toRemovalJob);

export const listCleanupRemovalJobActions = (
  jobId: string,
  statuses: readonly CleanupRemovalActionStatus[] = ["pending", "running", "succeeded", "failed", "skipped"],
): CleanupRemovalAction[] => {
  if (statuses.length === 0) {
    return [];
  }
  const placeholders = statuses.map(() => "?").join(", ");
  return getDb()
    .prepare<string[], RemovalActionRow>(`
      SELECT *
      FROM cleanup_removal_actions
      WHERE job_id = ? AND status IN (${placeholders})
      ORDER BY action_order ASC
    `)
    .all(jobId, ...statuses)
    .map(toRemovalAction);
};

export const markCleanupRemovalActionRunning = (
  actionId: string,
  nowMs = Date.now(),
): CleanupRemovalAction | null => withImmediateTransaction(() => {
  const result = getDb()
    .prepare(`
      UPDATE cleanup_removal_actions
      SET status = 'running',
          attempt_count = attempt_count + 1,
          started_at = COALESCE(started_at, ?),
          updated_at = ?,
          last_error = NULL
      WHERE id = ? AND status = 'pending'
    `)
    .run(nowMs, nowMs, actionId);
  if (result.changes === 0) {
    return null;
  }

  const row = getDb()
    .prepare<[string], RemovalActionRow>("SELECT * FROM cleanup_removal_actions WHERE id = ?")
    .get(actionId);
  return row ? toRemovalAction(row) : null;
});

export const markCleanupRemovalActionSucceeded = (
  actionId: string,
  status: string | null,
  nowMs = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_removal_actions
      SET status = 'succeeded',
          last_status = ?,
          last_error = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(status, nowMs, nowMs, actionId);
};

export const markCleanupRemovalActionFailed = (
  actionId: string,
  status: string | null,
  error: string,
  nowMs = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_removal_actions
      SET status = 'failed',
          last_status = ?,
          last_error = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(status, error.slice(0, 500), nowMs, nowMs, actionId);
};

export const markCleanupRemovalActionSkipped = (
  actionId: string,
  reason: string,
  nowMs = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_removal_actions
      SET status = 'skipped',
          last_error = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(reason.slice(0, 500), nowMs, nowMs, actionId);
};

export const markCleanupRemovalJobFailed = (
  jobId: string,
  error: string,
  nowMs = Date.now(),
): void => {
  getDb()
    .prepare(`
      UPDATE cleanup_removal_jobs
      SET status = 'failed',
          last_error = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(error.slice(0, 500), nowMs, nowMs, jobId);
};

export const getCleanupRemovalJobSummary = (jobId: string): CleanupRemovalJobSummary | null => {
  const job = getCleanupRemovalJob(jobId);
  if (!job) {
    return null;
  }

  const rows = getDb()
    .prepare<[string], { status: CleanupRemovalActionStatus; count: number }>(`
      SELECT status, COUNT(*) AS count
      FROM cleanup_removal_actions
      WHERE job_id = ?
      GROUP BY status
    `)
    .all(jobId);

  const counts: Record<CleanupRemovalActionStatus, number> = {
    pending: 0,
    running: 0,
    succeeded: 0,
    failed: 0,
    skipped: 0,
  };
  for (const row of rows) {
    counts[row.status] = row.count;
  }

  return {
    job,
    pending: counts.pending,
    running: counts.running,
    succeeded: counts.succeeded,
    failed: counts.failed,
    skipped: counts.skipped,
  };
};

export const completeCleanupRemovalJobIfFinished = (
  jobId: string,
  nowMs = Date.now(),
): CleanupRemovalJobSummary | null => withImmediateTransaction(() => {
  const summary = getCleanupRemovalJobSummary(jobId);
  if (!summary) {
    return null;
  }
  if (summary.pending > 0 || summary.running > 0) {
    return summary;
  }

  getDb()
    .prepare(`
      UPDATE cleanup_removal_jobs
      SET status = 'completed',
          completed_at = COALESCE(completed_at, ?),
          updated_at = ?,
          last_error = ?
      WHERE id = ? AND status IN ('queued','running')
    `)
    .run(
      nowMs,
      nowMs,
      summary.failed > 0 ? `${summary.failed} action(s) failed` : null,
      jobId,
    );

  return getCleanupRemovalJobSummary(jobId);
});

export const listCleanupMembers = (
  campaignId: string,
  limit = 5_000,
): CleanupMember[] =>
  getDb()
    .prepare<[string, number], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ?
      ORDER BY updated_at DESC
      LIMIT ?
    `)
    .all(campaignId, Math.min(Math.max(Math.trunc(limit), 1), 5_000))
    .map(toMember);

export const listCleanupDmMembers = (
  campaignId: string,
  status: CleanupDmStatus | "all",
  limit = 25,
): CleanupMember[] => {
  const safeLimit = Math.min(Math.max(Math.trunc(limit), 1), 200);
  const statusFilter = status === "all" ? "" : "AND dm_status = ?";
  const orderBy = status === "pending"
    ? "created_at ASC, user_id ASC"
    : status === "sent"
      ? "dm_sent_at DESC, updated_at DESC"
      : "updated_at DESC";
  const params = status === "all" ? [campaignId, safeLimit] : [campaignId, status, safeLimit];

  return getDb()
    .prepare<(string | number)[], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ?
        ${statusFilter}
      ORDER BY ${orderBy}
      LIMIT ?
    `)
    .all(...params)
    .map(toMember);
};

export const findCleanupMemberByUserOrJid = (
  campaignId: string,
  identifiers: readonly string[],
): CleanupMember | null => {
  const uniqueIdentifiers = Array.from(new Set(identifiers.map((identifier) => identifier.trim()).filter(Boolean)));
  if (uniqueIdentifiers.length === 0) {
    return null;
  }

  const placeholders = uniqueIdentifiers.map(() => "?").join(", ");
  const row = getDb()
    .prepare<string[], MemberRow>(`
      SELECT *
      FROM cleanup_members
      WHERE campaign_id = ?
        AND (user_id IN (${placeholders}) OR primary_jid IN (${placeholders}))
      ORDER BY whitelisted_at IS NOT NULL, updated_at DESC
      LIMIT 1
    `)
    .get(campaignId, ...uniqueIdentifiers, ...uniqueIdentifiers);

  return row ? toMember(row) : null;
};
