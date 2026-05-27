import { randomUUID } from "node:crypto";

import { assertUserWritable, getDb, withImmediateTransaction } from "../db.js";

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

export type CleanupMemberSeed = {
  userId: string;
  displayName?: string | null;
  primaryJid: string;
  firstSeenGroupJid?: string | null;
  protected?: boolean;
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
      insertMember.run(
        id,
        member.userId,
        member.displayName ?? null,
        member.primaryJid,
        member.firstSeenGroupJid ?? null,
        isProtected ? nowMs : null,
        isProtected ? "protected" : null,
        isProtected ? nowMs : null,
        isProtected ? "skipped" : "pending",
        nowMs,
        nowMs,
      );

      if (isProtected) {
        recordCleanupSignal(id, member.userId, "protected", member.firstSeenGroupJid ?? null, null, nowMs);
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
  const nextBatchSize = campaign.status === "active"
    ? Math.min(campaign.batchSize, dmPending)
    : 0;

  return {
    campaign,
    total,
    whitelisted,
    noSignal: Math.max(0, total - whitelisted),
    purgeCandidates: Math.max(0, total - whitelisted),
    dmPending,
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
