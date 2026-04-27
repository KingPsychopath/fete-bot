import { randomUUID } from "node:crypto";

import { getDb, withImmediateTransaction } from "../db.js";
import type { Config } from "../config.js";
import type { AnnouncementMentionCandidate } from "./mentions.js";
import { advanceLocalSchedule, nextLocalFromNow, type LocalDateTime } from "./time.js";

export type AnnouncementStatus = "draft" | "published";
export type AnnouncementCycleStatus = "running" | "sent" | "failed" | "skipped";
export type AnnouncementCycleItemStatus = "pending" | "sent" | "failed";

export type AnnouncementActor = {
  userId: string | null;
  label: string;
};

export interface AnnouncementQueueItemRow {
  id: string;
  position: number;
  body: string;
  status: AnnouncementStatus;
  enabled: boolean;
  createdByUserId: string | null;
  createdByLabel: string;
  createdAt: string;
  updatedByUserId: string | null;
  updatedByLabel: string;
  updatedAt: string;
}

export interface AnnouncementState {
  paused: boolean;
  nextLocalDate: string;
  nextLocalTime: string;
  timezone: string;
  activeCycleId: string | null;
  updatedAt: string;
}

export interface AnnouncementCycleRow {
  id: string;
  trigger: "scheduled" | "manual";
  targetGroupJid: string;
  status: AnnouncementCycleStatus;
  dueLocalDate: string;
  dueLocalTime: string;
  timezone: string;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
  error: string | null;
}

export interface AnnouncementCycleItemRow {
  id: string;
  cycleId: string;
  queueItemId: string;
  position: number;
  body: string;
  groupMentionsJson: string;
  status: AnnouncementCycleItemStatus;
  sentAt: string | null;
  error: string | null;
  createdAt: string;
  updatedAt: string;
}

type QueueItemDbRow = {
  id: string;
  position: number;
  body: string;
  status: AnnouncementStatus;
  enabled: 0 | 1;
  created_by_user_id: string | null;
  created_by_label: string;
  created_at: string;
  updated_by_user_id: string | null;
  updated_by_label: string;
  updated_at: string;
};

type StateDbRow = {
  paused: 0 | 1;
  next_local_date: string;
  next_local_time: string;
  timezone: string;
  active_cycle_id: string | null;
  updated_at: string;
};

type CycleDbRow = {
  id: string;
  trigger: "scheduled" | "manual";
  target_group_jid: string;
  status: AnnouncementCycleStatus;
  due_local_date: string;
  due_local_time: string;
  timezone: string;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
  error: string | null;
};

type CycleItemDbRow = {
  id: string;
  cycle_id: string;
  queue_item_id: string;
  position: number;
  body: string;
  group_mentions_json: string;
  status: AnnouncementCycleItemStatus;
  sent_at: string | null;
  error: string | null;
  created_at: string;
  updated_at: string;
};

const toQueueItem = (row: QueueItemDbRow): AnnouncementQueueItemRow => ({
  id: row.id,
  position: row.position,
  body: row.body,
  status: row.status,
  enabled: row.enabled === 1,
  createdByUserId: row.created_by_user_id,
  createdByLabel: row.created_by_label,
  createdAt: row.created_at,
  updatedByUserId: row.updated_by_user_id,
  updatedByLabel: row.updated_by_label,
  updatedAt: row.updated_at,
});

const toState = (row: StateDbRow): AnnouncementState => ({
  paused: row.paused === 1,
  nextLocalDate: row.next_local_date,
  nextLocalTime: row.next_local_time,
  timezone: row.timezone,
  activeCycleId: row.active_cycle_id,
  updatedAt: row.updated_at,
});

const toCycle = (row: CycleDbRow): AnnouncementCycleRow => ({
  id: row.id,
  trigger: row.trigger,
  targetGroupJid: row.target_group_jid,
  status: row.status,
  dueLocalDate: row.due_local_date,
  dueLocalTime: row.due_local_time,
  timezone: row.timezone,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  completedAt: row.completed_at,
  error: row.error,
});

const toCycleItem = (row: CycleItemDbRow): AnnouncementCycleItemRow => ({
  id: row.id,
  cycleId: row.cycle_id,
  queueItemId: row.queue_item_id,
  position: row.position,
  body: row.body,
  groupMentionsJson: row.group_mentions_json,
  status: row.status,
  sentAt: row.sent_at,
  error: row.error,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export const ensureAnnouncementState = (config: Config, now = new Date()): AnnouncementState => {
  const existing = getDb()
    .prepare<[], StateDbRow>("SELECT * FROM announcement_state WHERE id = 1")
    .get();
  if (existing) {
    return toState(existing);
  }

  const nextLocalDate = config.announcementsStartDate || nextLocalFromNow(
    now,
    config.announcementsTimezone,
    config.announcementsTime,
    0,
  ).date;
  const updatedAt = now.toISOString();
  getDb()
    .prepare<[string, string, string, string]>(`
      INSERT INTO announcement_state (
        id, paused, next_local_date, next_local_time, timezone, active_cycle_id, updated_at
      )
      VALUES (1, 0, ?, ?, ?, NULL, ?)
    `)
    .run(nextLocalDate, config.announcementsTime, config.announcementsTimezone, updatedAt);

  return getAnnouncementState()!;
};

export const getAnnouncementState = (): AnnouncementState | null => {
  const row = getDb()
    .prepare<[], StateDbRow>("SELECT * FROM announcement_state WHERE id = 1")
    .get();
  return row ? toState(row) : null;
};

export const setAnnouncementPaused = (paused: boolean, now = new Date()): AnnouncementState => {
  getDb()
    .prepare<[0 | 1, string]>("UPDATE announcement_state SET paused = ?, updated_at = ? WHERE id = 1")
    .run(paused ? 1 : 0, now.toISOString());
  return getAnnouncementState()!;
};

export const setAnnouncementSchedule = (
  local: LocalDateTime,
  now = new Date(),
): AnnouncementState => {
  getDb()
    .prepare<[string, string, string, string]>(`
      UPDATE announcement_state
      SET next_local_date = ?, next_local_time = ?, timezone = ?, updated_at = ?
      WHERE id = 1
    `)
    .run(local.date, local.time, local.timezone, now.toISOString());
  return getAnnouncementState()!;
};

export const advanceAnnouncementSchedule = (
  config: Config,
  fromNow: boolean,
  now = new Date(),
): AnnouncementState => {
  const state = ensureAnnouncementState(config, now);
  const next = fromNow
    ? nextLocalFromNow(now, state.timezone, state.nextLocalTime, config.announcementsIntervalDays)
    : advanceLocalSchedule(
        { date: state.nextLocalDate, time: state.nextLocalTime, timezone: state.timezone },
        config.announcementsIntervalDays,
        now,
      );
  return setAnnouncementSchedule(next, now);
};

export const listAnnouncementItems = (): AnnouncementQueueItemRow[] =>
  getDb()
    .prepare<[], QueueItemDbRow>(`
      SELECT *
      FROM announcement_queue_items
      WHERE removed_at IS NULL
      ORDER BY position ASC
    `)
    .all()
    .map(toQueueItem);

export const listActiveAnnouncementItems = (): AnnouncementQueueItemRow[] =>
  getDb()
    .prepare<[], QueueItemDbRow>(`
      SELECT *
      FROM announcement_queue_items
      WHERE removed_at IS NULL
        AND status = 'published'
        AND enabled = 1
      ORDER BY position ASC
    `)
    .all()
    .map(toQueueItem);

const nextPosition = (): number => {
  const row = getDb()
    .prepare<[], { max_position: number | null }>(`
      SELECT MAX(position) AS max_position
      FROM announcement_queue_items
      WHERE removed_at IS NULL
    `)
    .get();
  return (row?.max_position ?? 0) + 1;
};

export const addAnnouncementItem = (
  body: string,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow => {
  const timestamp = now.toISOString();
  const id = randomUUID();
  getDb()
    .prepare<[string, number, string, string | null, string, string, string | null, string, string]>(`
      INSERT INTO announcement_queue_items (
        id, position, body, status, enabled,
        created_by_user_id, created_by_label, created_at,
        updated_by_user_id, updated_by_label, updated_at
      )
      VALUES (?, ?, ?, 'draft', 1, ?, ?, ?, ?, ?, ?)
    `)
    .run(id, nextPosition(), body, actor.userId, actor.label, timestamp, actor.userId, actor.label, timestamp);
  return getAnnouncementItemByIdentifier(id)!;
};

export const getAnnouncementItemByIdentifier = (identifier: string): AnnouncementQueueItemRow | null => {
  const value = identifier.trim();
  if (!value) {
    return null;
  }

  const numeric = Number(value);
  if (Number.isInteger(numeric) && numeric > 0) {
    const byPosition = getDb()
      .prepare<[number], QueueItemDbRow>(`
        SELECT *
        FROM announcement_queue_items
        WHERE removed_at IS NULL AND position = ?
      `)
      .get(numeric);
    return byPosition ? toQueueItem(byPosition) : null;
  }

  const rows = getDb()
    .prepare<[string, string], QueueItemDbRow>(`
      SELECT *
      FROM announcement_queue_items
      WHERE removed_at IS NULL
        AND (id = ? OR id LIKE ?)
      ORDER BY position ASC
      LIMIT 2
    `)
    .all(value, `${value}%`);

  return rows.length === 1 ? toQueueItem(rows[0]!) : null;
};

export const updateAnnouncementBody = (
  identifier: string,
  body: string,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null => {
  const item = getAnnouncementItemByIdentifier(identifier);
  if (!item) {
    return null;
  }

  getDb()
    .prepare<[string, string | null, string, string, string]>(`
      UPDATE announcement_queue_items
      SET body = ?, updated_by_user_id = ?, updated_by_label = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(body, actor.userId, actor.label, now.toISOString(), item.id);
  return getAnnouncementItemByIdentifier(item.id);
};

export const publishAnnouncementItem = (
  identifier: string,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null => setAnnouncementStatus(identifier, "published", actor, now);

export const setAnnouncementItemEnabled = (
  identifier: string,
  enabled: boolean,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null => {
  const item = getAnnouncementItemByIdentifier(identifier);
  if (!item) {
    return null;
  }

  getDb()
    .prepare<[0 | 1, string | null, string, string, string]>(`
      UPDATE announcement_queue_items
      SET enabled = ?, updated_by_user_id = ?, updated_by_label = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(enabled ? 1 : 0, actor.userId, actor.label, now.toISOString(), item.id);
  return getAnnouncementItemByIdentifier(item.id);
};

const setAnnouncementStatus = (
  identifier: string,
  status: AnnouncementStatus,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null => {
  const item = getAnnouncementItemByIdentifier(identifier);
  if (!item) {
    return null;
  }

  getDb()
    .prepare<[AnnouncementStatus, string | null, string, string, string]>(`
      UPDATE announcement_queue_items
      SET status = ?, updated_by_user_id = ?, updated_by_label = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(status, actor.userId, actor.label, now.toISOString(), item.id);
  return getAnnouncementItemByIdentifier(item.id);
};

const reindexItems = (): void => {
  const items = listAnnouncementItems();
  const update = getDb().prepare<[number, string]>("UPDATE announcement_queue_items SET position = ? WHERE id = ?");
  items.forEach((item, index) => {
    update.run(index + 1, item.id);
  });
};

export const removeAnnouncementItem = (
  identifier: string,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null =>
  withImmediateTransaction(() => {
    const item = getAnnouncementItemByIdentifier(identifier);
    if (!item) {
      return null;
    }

    getDb()
      .prepare<[string, string | null, string, string, string]>(`
        UPDATE announcement_queue_items
        SET removed_at = ?, updated_by_user_id = ?, updated_by_label = ?, updated_at = ?
        WHERE id = ?
      `)
      .run(now.toISOString(), actor.userId, actor.label, now.toISOString(), item.id);
    reindexItems();
    return item;
  });

export const moveAnnouncementItem = (
  identifier: string,
  newPosition: number,
  actor: AnnouncementActor,
  now = new Date(),
): AnnouncementQueueItemRow | null =>
  withImmediateTransaction(() => {
    const item = getAnnouncementItemByIdentifier(identifier);
    const items = listAnnouncementItems();
    if (!item || !Number.isInteger(newPosition) || newPosition < 1 || newPosition > items.length) {
      return null;
    }

    const without = items.filter((candidate) => candidate.id !== item.id);
    without.splice(newPosition - 1, 0, item);
    const clearPosition = getDb().prepare<[number, string]>(`
      UPDATE announcement_queue_items
      SET position = ?
      WHERE id = ?
    `);
    without.forEach((candidate, index) => {
      clearPosition.run(-(index + 1), candidate.id);
    });
    const update = getDb().prepare<[number, string | null, string, string, string]>(`
      UPDATE announcement_queue_items
      SET position = ?, updated_by_user_id = ?, updated_by_label = ?, updated_at = ?
      WHERE id = ?
    `);
    without.forEach((candidate, index) => {
      update.run(index + 1, actor.userId, actor.label, now.toISOString(), candidate.id);
    });
    return getAnnouncementItemByIdentifier(item.id);
  });

export const getLastAnnouncementCycle = (): AnnouncementCycleRow | null => {
  const row = getDb()
    .prepare<[], CycleDbRow>(`
      SELECT *
      FROM announcement_cycles
      ORDER BY created_at DESC
      LIMIT 1
    `)
    .get();
  return row ? toCycle(row) : null;
};

export const getAnnouncementCycle = (cycleId: string): AnnouncementCycleRow | null => {
  const row = getDb()
    .prepare<[string], CycleDbRow>("SELECT * FROM announcement_cycles WHERE id = ?")
    .get(cycleId);
  return row ? toCycle(row) : null;
};

export const listPendingCycleItems = (cycleId: string): AnnouncementCycleItemRow[] =>
  getDb()
    .prepare<[string], CycleItemDbRow>(`
      SELECT *
      FROM announcement_cycle_items
      WHERE cycle_id = ?
        AND status IN ('pending', 'failed')
      ORDER BY position ASC
    `)
    .all(cycleId)
    .map(toCycleItem);

export const startAnnouncementCycle = (
  config: Config,
  trigger: "scheduled" | "manual",
  mentions: readonly AnnouncementMentionCandidate[],
  now = new Date(),
): { cycle: AnnouncementCycleRow; items: AnnouncementCycleItemRow[] } =>
  withImmediateTransaction(() => {
    const state = ensureAnnouncementState(config, now);
    if (state.activeCycleId) {
      const cycle = getAnnouncementCycle(state.activeCycleId);
      if (cycle && (cycle.status === "running" || cycle.status === "failed")) {
        return { cycle, items: listPendingCycleItems(cycle.id) };
      }
    }

    const activeItems = listActiveAnnouncementItems();
    const timestamp = now.toISOString();
    const cycleId = randomUUID();
    const status: AnnouncementCycleStatus = activeItems.length === 0 ? "skipped" : "running";

    getDb()
      .prepare<[string, "scheduled" | "manual", string, AnnouncementCycleStatus, string, string, string, string, string, string | null, string | null]>(`
        INSERT INTO announcement_cycles (
          id, trigger, target_group_jid, status,
          due_local_date, due_local_time, timezone,
          created_at, updated_at, completed_at, error
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(
        cycleId,
        trigger,
        config.announcementsTargetGroupJid,
        status,
        state.nextLocalDate,
        state.nextLocalTime,
        state.timezone,
        timestamp,
        timestamp,
        status === "skipped" ? timestamp : null,
        status === "skipped" ? "No active published announcement items" : null,
      );

    if (status === "running") {
      getDb()
        .prepare<[string, string]>("UPDATE announcement_state SET active_cycle_id = ?, updated_at = ? WHERE id = 1")
        .run(cycleId, timestamp);
    }

    const insertItem = getDb().prepare<[string, string, string, number, string, string, string, string]>(`
      INSERT INTO announcement_cycle_items (
        id, cycle_id, queue_item_id, position, body, group_mentions_json, status, created_at, updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?)
    `);
    for (const item of activeItems) {
      insertItem.run(
        randomUUID(),
        cycleId,
        item.id,
        item.position,
        item.body,
        JSON.stringify(mentions),
        timestamp,
        timestamp,
      );
    }

    return {
      cycle: getAnnouncementCycle(cycleId)!,
      items: listPendingCycleItems(cycleId),
    };
  });

export const markCycleItemSent = (itemId: string, now = new Date()): void => {
  getDb()
    .prepare<[string, string, string]>(`
      UPDATE announcement_cycle_items
      SET status = 'sent', sent_at = ?, error = NULL, updated_at = ?
      WHERE id = ?
    `)
    .run(now.toISOString(), now.toISOString(), itemId);
};

export const markCycleItemFailed = (itemId: string, message: string, now = new Date()): void => {
  getDb()
    .prepare<[string, string, string]>(`
      UPDATE announcement_cycle_items
      SET status = 'failed', error = ?, updated_at = ?
      WHERE id = ?
    `)
    .run(message, now.toISOString(), itemId);
};

export const completeAnnouncementCycle = (
  cycleId: string,
  status: "sent" | "failed" | "skipped",
  error: string | null,
  now = new Date(),
): void => {
  getDb()
    .prepare<[AnnouncementCycleStatus, string, string | null, string | null, string]>(`
      UPDATE announcement_cycles
      SET status = ?, updated_at = ?, completed_at = ?, error = ?
      WHERE id = ?
    `)
    .run(status, now.toISOString(), status === "failed" ? null : now.toISOString(), error, cycleId);

  if (status !== "failed") {
    getDb()
      .prepare<[string, string]>("UPDATE announcement_state SET active_cycle_id = NULL, updated_at = ? WHERE active_cycle_id = ?")
      .run(now.toISOString(), cycleId);
  }
};

export const hasPendingCycleItems = (cycleId: string): boolean => listPendingCycleItems(cycleId).length > 0;
