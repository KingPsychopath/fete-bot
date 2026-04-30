import { randomUUID } from "node:crypto";

import {
  getDb,
  withImmediateTransaction,
  type SpotlightIntent,
  type SpotlightPendingRow,
  type SpotlightSummaryRow,
} from "../../../db.js";

type SpotlightPendingDbRow = {
  id: string;
  source_group_jid: string;
  source_msg_id: string;
  sender_user_id: string;
  sender_jid: string;
  body: string;
  classified_intent: SpotlightIntent;
  scheduled_at: string;
  status: "pending" | "sent" | "cancelled";
  cancel_reason: string | null;
  claimed_at: string | null;
  claimed_by: string | null;
  created_at: string;
  updated_at: string;
};

export type SpotlightOutcomeRow = SpotlightPendingRow & {
  sentTargetGroupJids: string[];
};

export type QueueSpotlightInput = {
  sourceGroupJid: string;
  sourceMsgId: string;
  senderUserId: string;
  senderJid: string;
  body: string;
  classifiedIntent: SpotlightIntent;
  scheduledAt: string;
};

const toPendingRow = (row: SpotlightPendingDbRow): SpotlightPendingRow => ({
  id: row.id,
  sourceGroupJid: row.source_group_jid,
  sourceMsgId: row.source_msg_id,
  senderUserId: row.sender_user_id,
  senderJid: row.sender_jid,
  body: row.body,
  classifiedIntent: row.classified_intent,
  scheduledAt: row.scheduled_at,
  status: row.status,
  cancelReason: row.cancel_reason,
  claimedAt: row.claimed_at,
  claimedBy: row.claimed_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const queueSpotlight = (input: QueueSpotlightInput): SpotlightPendingRow | null => {
  const now = new Date().toISOString();
  const id = randomUUID();
  const result = getDb()
    .prepare(`
      INSERT OR IGNORE INTO spotlight_pending (
        id,
        source_group_jid,
        source_msg_id,
        sender_user_id,
        sender_jid,
        body,
        classified_intent,
        scheduled_at,
        status,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `)
    .run(
      id,
      input.sourceGroupJid,
      input.sourceMsgId,
      input.senderUserId,
      input.senderJid,
      input.body,
      input.classifiedIntent,
      input.scheduledAt,
      now,
      now,
    );

  if (result.changes === 0) {
    return null;
  }

  return getPendingById(id);
};

export const getPendingById = (id: string): SpotlightPendingRow | null => {
  const row = getDb()
    .prepare<[string], SpotlightPendingDbRow>(`
      SELECT *
      FROM spotlight_pending
      WHERE id = ?
    `)
    .get(id);

  return row ? toPendingRow(row) : null;
};

export const getSpotlightByIdentifier = (identifier: string): SpotlightPendingRow | null => {
  const value = identifier.trim();
  if (!value) {
    return null;
  }

  const row = getDb()
    .prepare<[string, string, string], SpotlightPendingDbRow>(`
      SELECT *
      FROM spotlight_pending
      WHERE id = ?
         OR source_msg_id = ?
         OR lower(source_msg_id) = lower(?)
      ORDER BY updated_at DESC
      LIMIT 1
    `)
    .get(value, value, value);

  return row ? toPendingRow(row) : null;
};

export const listPendingSpotlights = (limit = 20): SpotlightPendingRow[] =>
  getDb()
    .prepare<[number], SpotlightPendingDbRow>(`
      SELECT *
      FROM spotlight_pending
      WHERE status = 'pending'
      ORDER BY scheduled_at ASC
      LIMIT ?
    `)
    .all(limit)
    .map(toPendingRow);

export const hasPendingSpotlightForSender = (senderUserId: string): boolean => {
  const row = getDb()
    .prepare<[string], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM spotlight_pending
      WHERE sender_user_id = ? AND status = 'pending'
    `)
    .get(senderUserId);

  return (row?.count ?? 0) > 0;
};

export const hasPendingSpotlightForSenderInGroup = (
  sourceGroupJid: string,
  senderUserId: string,
  classifiedIntent?: SpotlightIntent,
): boolean => {
  const intentFilter = classifiedIntent ? "AND classified_intent = ?" : "";
  const row = getDb()
    .prepare<[string, string, SpotlightIntent?], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM spotlight_pending
      WHERE source_group_jid = ? AND sender_user_id = ? AND status = 'pending'
      ${intentFilter}
    `)
    .get(sourceGroupJid, senderUserId, classifiedIntent);

  return (row?.count ?? 0) > 0;
};

export const claimDueSpotlights = (
  nowIso: string,
  staleBeforeIso: string,
  claimedBy: string,
  limit = 10,
): SpotlightPendingRow[] =>
  withImmediateTransaction(() => {
    const rows = getDb()
      .prepare<[string, string, number], SpotlightPendingDbRow>(`
        SELECT *
        FROM spotlight_pending
        WHERE status = 'pending'
          AND scheduled_at <= ?
          AND (claimed_at IS NULL OR claimed_at < ?)
        ORDER BY scheduled_at ASC
        LIMIT ?
      `)
      .all(nowIso, staleBeforeIso, limit);

    if (rows.length === 0) {
      return [];
    }

    const update = getDb().prepare<[string, string, string, string, string]>(`
      UPDATE spotlight_pending
      SET claimed_at = ?, claimed_by = ?, updated_at = ?
      WHERE id = ?
        AND status = 'pending'
        AND (claimed_at IS NULL OR claimed_at < ?)
    `);

    const claimed: SpotlightPendingRow[] = [];
    for (const row of rows) {
      const result = update.run(nowIso, claimedBy, nowIso, row.id, staleBeforeIso);
      if (result.changes > 0) {
        const next = getPendingById(row.id);
        if (next) {
          claimed.push(next);
        }
      }
    }

    return claimed;
  });

export const markSpotlightSent = (pendingId: string, claimedBy: string, sentAt: string): boolean => {
  const result = getDb()
    .prepare<[string, string, string]>(`
      UPDATE spotlight_pending
      SET status = 'sent', updated_at = ?
      WHERE id = ? AND status = 'pending' AND claimed_by = ?
    `)
    .run(sentAt, pendingId, claimedBy);

  return result.changes > 0;
};

export const cancelClaimedSpotlight = (
  pendingId: string,
  claimedBy: string,
  reason: string,
  nowIso = new Date().toISOString(),
): boolean => {
  const result = getDb()
    .prepare<[string, string, string, string]>(`
      UPDATE spotlight_pending
      SET status = 'cancelled', cancel_reason = ?, updated_at = ?
      WHERE id = ? AND status = 'pending' AND claimed_by = ?
    `)
    .run(reason, nowIso, pendingId, claimedBy);

  return result.changes > 0;
};

export const rescheduleClaimedSpotlight = (
  pendingId: string,
  claimedBy: string,
  scheduledAt: string,
  nowIso = new Date().toISOString(),
): boolean => {
  const result = getDb()
    .prepare<[string, string, string, string]>(`
      UPDATE spotlight_pending
      SET scheduled_at = ?, claimed_at = NULL, claimed_by = NULL, updated_at = ?
      WHERE id = ? AND status = 'pending' AND claimed_by = ?
    `)
    .run(scheduledAt, nowIso, pendingId, claimedBy);

  return result.changes > 0;
};

export const requeueSpotlight = (
  identifier: string,
  scheduledAt: string,
  nowIso = new Date().toISOString(),
): SpotlightPendingRow | null => {
  const existing = getSpotlightByIdentifier(identifier);
  if (!existing) {
    return null;
  }

  const result = getDb()
    .prepare<[string, string, string]>(`
      UPDATE spotlight_pending
      SET status = 'pending',
          cancel_reason = NULL,
          claimed_at = NULL,
          claimed_by = NULL,
          scheduled_at = ?,
          updated_at = ?
      WHERE id = ?
    `)
    .run(scheduledAt, nowIso, existing.id);

  return result.changes > 0 ? getPendingById(existing.id) : null;
};

export const requeueFailedSpotlights = (
  sinceIso: string,
  scheduledAt: string,
  nowIso = new Date().toISOString(),
  limit = 50,
): SpotlightPendingRow[] =>
  withImmediateTransaction(() => {
    const rows = getDb()
      .prepare<[string, number], SpotlightPendingDbRow>(`
        SELECT *
        FROM spotlight_pending
        WHERE status = 'cancelled'
          AND updated_at >= ?
        ORDER BY updated_at DESC
        LIMIT ?
      `)
      .all(sinceIso, limit);

    if (rows.length === 0) {
      return [];
    }

    const update = getDb().prepare<[string, string, string]>(`
      UPDATE spotlight_pending
      SET status = 'pending',
          cancel_reason = NULL,
          claimed_at = NULL,
          claimed_by = NULL,
          scheduled_at = ?,
          updated_at = ?
      WHERE id = ? AND status = 'cancelled'
    `);

    const requeued: SpotlightPendingRow[] = [];
    for (const row of rows) {
      const result = update.run(scheduledAt, nowIso, row.id);
      if (result.changes > 0) {
        const next = getPendingById(row.id);
        if (next) {
          requeued.push(next);
        }
      }
    }

    return requeued;
  });

export const cancelSpotlightsForSource = (
  sourceGroupJid: string,
  sourceMsgId: string,
  reason: string,
  nowIso = new Date().toISOString(),
): number => {
  const result = getDb()
    .prepare<[string, string, string, string]>(`
      UPDATE spotlight_pending
      SET status = 'cancelled', cancel_reason = ?, updated_at = ?
      WHERE source_group_jid = ? AND source_msg_id = ? AND status = 'pending'
    `)
    .run(reason, nowIso, sourceGroupJid, sourceMsgId);

  return result.changes;
};

export const cancelPendingSpotlightsForSenderInGroup = (
  sourceGroupJid: string,
  senderUserId: string,
  reason: string,
  nowIso = new Date().toISOString(),
  classifiedIntent?: SpotlightIntent,
): number => {
  const intentFilter = classifiedIntent ? "AND classified_intent = ?" : "";
  const result = getDb()
    .prepare<[string, string, string, string, SpotlightIntent?]>(`
      UPDATE spotlight_pending
      SET status = 'cancelled', cancel_reason = ?, updated_at = ?
      WHERE source_group_jid = ? AND sender_user_id = ? AND status = 'pending'
      ${intentFilter}
    `)
    .run(reason, nowIso, sourceGroupJid, senderUserId, classifiedIntent);

  return result.changes;
};

export const recordSpotlightHistory = (
  pending: SpotlightPendingRow,
  targetGroupJid: string,
  sentAt: string,
): void => {
  getDb()
    .prepare(`
      INSERT INTO spotlight_history (
        id,
        sender_user_id,
        sender_jid,
        source_group_jid,
        source_msg_id,
        target_group_jid,
        sent_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(
      randomUUID(),
      pending.senderUserId,
      pending.senderJid,
      pending.sourceGroupJid,
      pending.sourceMsgId,
      targetGroupJid,
      sentAt,
    );
};

export const hasUserSpotlightSince = (senderUserId: string, sinceIso: string): boolean => {
  const row = getDb()
    .prepare<[string, string], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM spotlight_history
      WHERE sender_user_id = ? AND sent_at >= ?
    `)
    .get(senderUserId, sinceIso);

  return (row?.count ?? 0) > 0;
};

export const hasTargetGroupSpotlightSince = (targetGroupJid: string, sinceIso: string): boolean => {
  const row = getDb()
    .prepare<[string, string], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM spotlight_history
      WHERE target_group_jid = ? AND sent_at >= ?
    `)
    .get(targetGroupJid, sinceIso);

  return (row?.count ?? 0) > 0;
};

export const getTargetGroupSpotlightCountSince = (targetGroupJid: string, sinceIso: string): number => {
  const row = getDb()
    .prepare<[string, string], { count: number }>(`
      SELECT COUNT(*) AS count
      FROM spotlight_history
      WHERE target_group_jid = ? AND sent_at >= ?
    `)
    .get(targetGroupJid, sinceIso);

  return row?.count ?? 0;
};

export const getSpotlightSummarySince = (sinceIso: string): SpotlightSummaryRow[] =>
  getDb()
    .prepare<[string, string], { status: "queued" | "sent" | "cancelled"; cancel_reason: string | null; count: number }>(`
      SELECT 'queued' AS status, NULL AS cancel_reason, COUNT(*) AS count
      FROM spotlight_pending
      WHERE created_at >= ?
      UNION ALL
      SELECT status, cancel_reason, COUNT(*) AS count
      FROM spotlight_pending
      WHERE updated_at >= ?
        AND status IN ('sent', 'cancelled')
      GROUP BY status, cancel_reason
      ORDER BY status, cancel_reason
    `)
    .all(sinceIso, sinceIso)
    .map((row) => ({
      status: row.status,
      cancelReason: row.cancel_reason,
      count: row.count,
    }));

export const listRecentSpotlightOutcomes = (limit = 10): SpotlightOutcomeRow[] =>
  getDb()
    .prepare<[number], SpotlightPendingDbRow & { target_group_jids: string | null }>(`
      SELECT
        p.*,
        GROUP_CONCAT(h.target_group_jid) AS target_group_jids
      FROM spotlight_pending p
      LEFT JOIN spotlight_history h
        ON h.source_group_jid = p.source_group_jid
       AND h.source_msg_id = p.source_msg_id
      WHERE p.status IN ('sent', 'cancelled')
      GROUP BY p.id
      ORDER BY p.updated_at DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      ...toPendingRow(row),
      sentTargetGroupJids: row.target_group_jids
        ? row.target_group_jids.split(",").filter((jid) => jid.length > 0)
        : [],
    }));
