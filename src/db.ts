import { mkdirSync } from "fs";
import path from "node:path";

import Database from "better-sqlite3";

export type LogAction = "DELETED" | "DRY_RUN" | "ERROR" | "WARN";

export type LogEntry = {
  timestamp: string;
  group_jid: string;
  user_jid: string;
  push_name?: string | null;
  message_text?: string | null;
  url_found?: string | null;
  action: LogAction;
  reason?: string | null;
};

type CountRow = {
  count: number;
};

export type StrikeGroupRow = {
  group_jid: string;
  count: number;
};

export interface Ban {
  userJid: string;
  groupJid: string;
  bannedBy: string;
  reason: string | null;
  timestamp: string;
}

export interface Mute {
  userJid: string;
  groupJid: string;
  mutedBy: string;
  reason: string | null;
  mutedAt: string;
  expiresAt: string | null;
}

export interface AuditEntry {
  timestamp: string;
  actorJid: string;
  actorRole: "owner" | "moderator";
  command: string;
  targetJid: string | null;
  groupJid: string | null;
  rawInput: string | null;
  result: "success" | "error" | "pending";
}

export interface Moderator {
  jid: string;
  addedBy: string;
  note: string | null;
  addedAt: string;
}

export interface ReviewQueueEntry {
  userJid: string;
  groupJid: string;
  pushName: string | null;
  reason: string;
  messageText: string | null;
  flaggedAt: string;
}

const DATA_DIR = path.resolve(process.cwd(), "data");
const DATABASE_PATH = path.join(DATA_DIR, "bot.db");

let db: Database.Database | null = null;

const getDb = (): Database.Database => {
  if (!db) {
    throw new Error("Database has not been initialised");
  }

  return db;
};

export const initDb = (): void => {
  if (db) {
    return;
  }

  mkdirSync("./data", { recursive: true });

  db = new Database(DATABASE_PATH);
  db.exec(`
    CREATE TABLE IF NOT EXISTS logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      user_jid TEXT NOT NULL,
      push_name TEXT,
      message_text TEXT,
      url_found TEXT,
      action TEXT NOT NULL CHECK(action IN ('DELETED','DRY_RUN','ERROR','WARN')),
      reason TEXT
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS strikes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      reason TEXT NOT NULL,
      timestamp TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bans (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      lid_jid TEXT,
      group_jid TEXT NOT NULL,
      banned_by TEXT NOT NULL,
      reason TEXT,
      timestamp TEXT NOT NULL,
      UNIQUE(user_jid, group_jid)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS mutes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      lid_jid TEXT,
      group_jid TEXT NOT NULL,
      muted_by TEXT NOT NULL,
      reason TEXT,
      muted_at TEXT NOT NULL,
      expires_at TEXT,
      UNIQUE(user_jid, group_jid)
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS moderators (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      jid TEXT NOT NULL UNIQUE,
      added_by TEXT NOT NULL,
      note TEXT,
      added_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor_jid TEXT NOT NULL,
      actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','moderator')),
      command TEXT NOT NULL,
      target_jid TEXT,
      group_jid TEXT,
      raw_input TEXT,
      result TEXT NOT NULL CHECK(result IN ('success','error','pending'))
    )
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS review_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_jid TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      push_name TEXT,
      reason TEXT NOT NULL,
      message_text TEXT,
      flagged_at TEXT NOT NULL,
      UNIQUE(user_jid, group_jid)
    )
  `);

  const tableInfo = db
    .prepare<[], { name: string }>("PRAGMA table_info(logs)")
    .all();
  const tableSql = db
    .prepare<[], { sql: string | null }>(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'logs'",
    )
    .get();
  const needsReasonColumn = !tableInfo.some((column) => column.name === "reason");
  const supportsWarnAction = tableSql?.sql?.includes("'WARN'") ?? false;

  if (needsReasonColumn || !supportsWarnAction) {
    db.exec(`
      ALTER TABLE logs RENAME TO logs_old;
      CREATE TABLE logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        group_jid TEXT NOT NULL,
        user_jid TEXT NOT NULL,
        push_name TEXT,
        message_text TEXT,
        url_found TEXT,
        action TEXT NOT NULL CHECK(action IN ('DELETED','DRY_RUN','ERROR','WARN')),
        reason TEXT
      );
      INSERT INTO logs (
        id,
        timestamp,
        group_jid,
        user_jid,
        push_name,
        message_text,
        url_found,
        action,
        reason
      )
      SELECT
        id,
        timestamp,
        group_jid,
        user_jid,
        push_name,
        message_text,
        url_found,
        action,
        NULL
      FROM logs_old;
      DROP TABLE logs_old;
    `);
  }

  const bansColumns = db.prepare<[], { name: string }>("PRAGMA table_info(bans)").all();
  if (!bansColumns.some((column) => column.name === "lid_jid")) {
    db.exec("ALTER TABLE bans ADD COLUMN lid_jid TEXT");
  }

  const mutesColumns = db.prepare<[], { name: string }>("PRAGMA table_info(mutes)").all();
  if (!mutesColumns.some((column) => column.name === "lid_jid")) {
    db.exec("ALTER TABLE mutes ADD COLUMN lid_jid TEXT");
  }

  const auditColumns = db.prepare<[], { name: string }>("PRAGMA table_info(audit_log)").all();
  const hasActorColumns =
    auditColumns.some((column) => column.name === "actor_jid") &&
    auditColumns.some((column) => column.name === "actor_role");

  if (!hasActorColumns) {
    db.exec(`
      ALTER TABLE audit_log RENAME TO audit_log_old;
      CREATE TABLE audit_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp TEXT NOT NULL,
        actor_jid TEXT NOT NULL,
        actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','moderator')),
        command TEXT NOT NULL,
        target_jid TEXT,
        group_jid TEXT,
        raw_input TEXT,
        result TEXT NOT NULL CHECK(result IN ('success','error','pending'))
      );
      INSERT INTO audit_log (
        id,
        timestamp,
        actor_jid,
        actor_role,
        command,
        target_jid,
        group_jid,
        raw_input,
        result
      )
      SELECT
        id,
        timestamp,
        admin_jid,
        'owner',
        command,
        target_jid,
        group_jid,
        raw_input,
        result
      FROM audit_log_old;
      DROP TABLE audit_log_old;
    `);
  }

  const reviewColumns = db.prepare<[], { name: string }>("PRAGMA table_info(review_queue)").all();
  if (!reviewColumns.some((column) => column.name === "message_text")) {
    db.exec("ALTER TABLE review_queue ADD COLUMN message_text TEXT");
  }
};

export const logAction = (entry: LogEntry): void => {
  const database = getDb();
  database
    .prepare<LogEntry>(`
      INSERT INTO logs (
        timestamp,
        group_jid,
        user_jid,
        push_name,
        message_text,
        url_found,
        action,
        reason
      ) VALUES (
        @timestamp,
        @group_jid,
        @user_jid,
        @push_name,
        @message_text,
        @url_found,
        @action,
        @reason
      )
    `)
    .run(entry);
};

export const purgeExpiredStrikes = (): void => {
  const database = getDb();
  database.prepare<[string]>("DELETE FROM strikes WHERE expires_at < ?").run(new Date().toISOString());
};

export const getActiveStrikes = (userJid: string, groupJid: string): number => {
  const database = getDb();
  const result = database
    .prepare<[string, string, string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE user_jid = ? AND group_jid = ? AND expires_at > ?
    `)
    .get(userJid, groupJid, new Date().toISOString());

  return result?.count ?? 0;
};

export const addStrike = (userJid: string, groupJid: string, reason: string): number => {
  const database = getDb();
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000);

  database
    .prepare<[string, string, string, string, string]>(`
      INSERT INTO strikes (
        user_jid,
        group_jid,
        reason,
        timestamp,
        expires_at
      ) VALUES (?, ?, ?, ?, ?)
    `)
    .run(userJid, groupJid, reason, timestamp.toISOString(), expiresAt.toISOString());

  return getActiveStrikes(userJid, groupJid);
};

export const resetStrikes = (userJid: string, groupJid: string): void => {
  const database = getDb();
  database.prepare<[string, string]>("DELETE FROM strikes WHERE user_jid = ? AND group_jid = ?").run(userJid, groupJid);
};

export const resetAllStrikes = (groupJid?: string): void => {
  const database = getDb();

  if (groupJid) {
    database.prepare<[string]>("DELETE FROM strikes WHERE group_jid = ?").run(groupJid);
    return;
  }

  database.prepare("DELETE FROM strikes").run();
};

export const getActiveStrikesAcrossGroups = (userJid: string): StrikeGroupRow[] => {
  const database = getDb();
  return database
    .prepare<[string, string], StrikeGroupRow>(`
      SELECT group_jid, COUNT(*) as count
      FROM strikes
      WHERE user_jid = ? AND expires_at > ?
      GROUP BY group_jid
      ORDER BY group_jid ASC
    `)
    .all(userJid, new Date().toISOString());
};

export const getStrikesIssuedToday = (): number => {
  const database = getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);

  const result = database
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE timestamp >= ?
    `)
    .get(start.toISOString());

  return result?.count ?? 0;
};

export const getTotalActiveStrikes = (): number => {
  const database = getDb();
  const result = database
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE expires_at > ?
    `)
    .get(new Date().toISOString());

  return result?.count ?? 0;
};

export const addBan = (
  userJid: string,
  groupJid: string,
  bannedBy: string,
  reason?: string,
  lidJid?: string | null,
): void => {
  const database = getDb();
  database
    .prepare<[string, string | null, string, string, string | null, string]>(`
      INSERT INTO bans (
        user_jid,
        lid_jid,
        group_jid,
        banned_by,
        reason,
        timestamp
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_jid, group_jid) DO UPDATE SET
        lid_jid = excluded.lid_jid,
        banned_by = excluded.banned_by,
        reason = excluded.reason,
        timestamp = excluded.timestamp
    `)
    .run(userJid, lidJid ?? null, groupJid, bannedBy, reason ?? null, new Date().toISOString());
};

export const removeBan = (userJid: string, groupJid: string): void => {
  const database = getDb();
  database
    .prepare<[string, string, string]>(`
      DELETE FROM bans
      WHERE group_jid = ? AND (user_jid = ? OR lid_jid = ?)
    `)
    .run(groupJid, userJid, userJid);
};

export const removeAllBans = (groupJid?: string): void => {
  const database = getDb();
  if (groupJid) {
    database.prepare<[string]>("DELETE FROM bans WHERE group_jid = ?").run(groupJid);
    return;
  }

  database.prepare("DELETE FROM bans").run();
};

export const isBanned = (userJid: string, groupJid: string): boolean => {
  const database = getDb();
  const result = database
    .prepare<[string, string, string], { count: number }>(`
      SELECT COUNT(*) as count
      FROM bans
      WHERE group_jid = ? AND (user_jid = ? OR lid_jid = ?)
    `)
    .get(groupJid, userJid, userJid);

  return (result?.count ?? 0) > 0;
};

export const getBans = (groupJid: string): Ban[] => {
  const database = getDb();
  return database
    .prepare<
      [string],
      {
        user_jid: string;
        group_jid: string;
        banned_by: string;
        reason: string | null;
        timestamp: string;
      }
    >(`
      SELECT user_jid, group_jid, banned_by, reason, timestamp
      FROM bans
      WHERE group_jid = ?
      ORDER BY timestamp ASC
    `)
    .all(groupJid)
    .map((row) => ({
      userJid: row.user_jid,
      groupJid: row.group_jid,
      bannedBy: row.banned_by,
      reason: row.reason,
      timestamp: row.timestamp,
    }));
};

export const addMute = (
  userJid: string,
  groupJid: string,
  mutedBy: string,
  expiresAt: Date | null,
  reason?: string,
  lidJid?: string | null,
): void => {
  const database = getDb();
  database
    .prepare<[string, string | null, string, string, string | null, string, string | null]>(`
      INSERT INTO mutes (
        user_jid,
        lid_jid,
        group_jid,
        muted_by,
        reason,
        muted_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_jid, group_jid) DO UPDATE SET
        lid_jid = excluded.lid_jid,
        muted_by = excluded.muted_by,
        reason = excluded.reason,
        muted_at = excluded.muted_at,
        expires_at = excluded.expires_at
    `)
    .run(
      userJid,
      lidJid ?? null,
      groupJid,
      mutedBy,
      reason ?? null,
      new Date().toISOString(),
      expiresAt ? expiresAt.toISOString() : null,
    );
};

export const removeMute = (userJid: string, groupJid: string): void => {
  const database = getDb();
  database
    .prepare<[string, string, string]>(`
      DELETE FROM mutes
      WHERE group_jid = ? AND (user_jid = ? OR lid_jid = ?)
    `)
    .run(groupJid, userJid, userJid);
};

export const removeAllMutes = (groupJid?: string): void => {
  const database = getDb();
  if (groupJid) {
    database.prepare<[string]>("DELETE FROM mutes WHERE group_jid = ?").run(groupJid);
    return;
  }

  database.prepare("DELETE FROM mutes").run();
};

export const isMuted = (userJid: string, groupJid: string): boolean => {
  const database = getDb();
  const result = database
    .prepare<[string, string, string, string], { count: number }>(`
      SELECT COUNT(*) as count
      FROM mutes
      WHERE group_jid = ?
        AND (user_jid = ? OR lid_jid = ?)
        AND (expires_at IS NULL OR expires_at > ?)
    `)
    .get(groupJid, userJid, userJid, new Date().toISOString());

  return (result?.count ?? 0) > 0;
};

export const getActiveMutes = (groupJid: string): Mute[] => {
  const database = getDb();
  return database
    .prepare<
      [string, string],
      {
        user_jid: string;
        group_jid: string;
        muted_by: string;
        reason: string | null;
        muted_at: string;
        expires_at: string | null;
      }
    >(`
      SELECT user_jid, group_jid, muted_by, reason, muted_at, expires_at
      FROM mutes
      WHERE group_jid = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY muted_at ASC
    `)
    .all(groupJid, new Date().toISOString())
    .map((row) => ({
      userJid: row.user_jid,
      groupJid: row.group_jid,
      mutedBy: row.muted_by,
      reason: row.reason,
      mutedAt: row.muted_at,
      expiresAt: row.expires_at,
    }));
};

export const purgeExpiredMutes = (): void => {
  const database = getDb();
  database
    .prepare<[string]>("DELETE FROM mutes WHERE expires_at IS NOT NULL AND expires_at < ?")
    .run(new Date().toISOString());
};

export const getTotalActiveBans = (): number => {
  const database = getDb();
  const result = database
    .prepare<[], CountRow>("SELECT COUNT(*) as count FROM bans")
    .get();

  return result?.count ?? 0;
};

export const getTotalActiveMutes = (): number => {
  const database = getDb();
  const result = database
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM mutes
      WHERE expires_at IS NULL OR expires_at > ?
    `)
    .get(new Date().toISOString());

  return result?.count ?? 0;
};

export const removeLatestStrike = (userJid: string, groupJid: string): void => {
  const database = getDb();
  database
    .prepare<[string, string]>(`
      DELETE FROM strikes
      WHERE id = (
        SELECT id
        FROM strikes
        WHERE user_jid = ? AND group_jid = ?
        ORDER BY timestamp DESC
        LIMIT 1
      )
    `)
    .run(userJid, groupJid);
};

export const testDbWritable = (): boolean => {
  const database = getDb();
  const timestamp = new Date().toISOString();
  const result = database
    .prepare<[string, string, string, string, string, string | null, string, string]>(`
      INSERT INTO logs (
        timestamp,
        group_jid,
        user_jid,
        push_name,
        message_text,
        url_found,
        action,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(timestamp, "__health__", "__health__", "health-check", "health-check", null, "WARN", "health check");

  database.prepare<[number]>("DELETE FROM logs WHERE id = ?").run(Number(result.lastInsertRowid));
  return true;
};

export const closeDb = (): void => {
  if (!db) {
    return;
  }

  db.close();
  db = null;
};

export const logAuditEntry = (entry: AuditEntry): void => {
  const database = getDb();
  database
    .prepare<AuditEntry>(`
      INSERT INTO audit_log (
        timestamp,
        actor_jid,
        actor_role,
        command,
        target_jid,
        group_jid,
        raw_input,
        result
      ) VALUES (
        @timestamp,
        @actorJid,
        @actorRole,
        @command,
        @targetJid,
        @groupJid,
        @rawInput,
        @result
      )
    `)
    .run(entry);
};

export const getAuditEntries = (limit = 20): AuditEntry[] => {
  const database = getDb();
  return database
    .prepare<
      [number],
      {
        timestamp: string;
        actor_jid: string;
        actor_role: "owner" | "moderator";
        command: string;
        target_jid: string | null;
        group_jid: string | null;
        raw_input: string | null;
        result: "success" | "error" | "pending";
      }
    >(`
      SELECT timestamp, actor_jid, actor_role, command, target_jid, group_jid, raw_input, result
      FROM audit_log
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      timestamp: row.timestamp,
      actorJid: row.actor_jid,
      actorRole: row.actor_role,
      command: row.command,
      targetJid: row.target_jid,
      groupJid: row.group_jid,
      rawInput: row.raw_input,
      result: row.result,
    }));
};

export const getForwardedMessagesSeenToday = (): number => {
  const database = getDb();
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const result = database
    .prepare<[string, string], CountRow>(`
      SELECT COUNT(*) as count
      FROM logs
      WHERE timestamp >= ? AND reason = ?
    `)
    .get(start.toISOString(), "forwarded message");

  return result?.count ?? 0;
};

export const upsertReviewQueueEntry = (
  userJid: string,
  groupJid: string,
  pushName: string | null,
  reason: string,
  messageText: string | null,
): void => {
  const database = getDb();
  database
    .prepare<[string, string, string | null, string, string | null, string]>(`
      INSERT INTO review_queue (
        user_jid,
        group_jid,
        push_name,
        reason,
        message_text,
        flagged_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_jid, group_jid) DO UPDATE SET
        push_name = excluded.push_name,
        reason = excluded.reason,
        message_text = excluded.message_text,
        flagged_at = excluded.flagged_at
    `)
    .run(userJid, groupJid, pushName, reason, messageText, new Date().toISOString());
};

export const clearReviewQueueEntry = (userJid: string, groupJid: string): void => {
  const database = getDb();
  database
    .prepare<[string, string]>("DELETE FROM review_queue WHERE user_jid = ? AND group_jid = ?")
    .run(userJid, groupJid);
};

export const listReviewQueueEntries = (): ReviewQueueEntry[] => {
  const database = getDb();
  return database
    .prepare<
      [],
      {
        user_jid: string;
        group_jid: string;
        push_name: string | null;
        reason: string;
        message_text: string | null;
        flagged_at: string;
      }
    >(`
      SELECT user_jid, group_jid, push_name, reason, message_text, flagged_at
      FROM review_queue
      ORDER BY flagged_at DESC
    `)
    .all()
    .map((row) => ({
      userJid: row.user_jid,
      groupJid: row.group_jid,
      pushName: row.push_name,
      reason: row.reason,
      messageText: row.message_text,
      flaggedAt: row.flagged_at,
    }));
};

export const addModerator = (jid: string, addedBy: string, note?: string): void => {
  const database = getDb();
  database
    .prepare<[string, string, string | null, string]>(`
      INSERT INTO moderators (
        jid,
        added_by,
        note,
        added_at
      ) VALUES (?, ?, ?, ?)
      ON CONFLICT(jid) DO UPDATE SET
        added_by = excluded.added_by,
        note = excluded.note,
        added_at = excluded.added_at
    `)
    .run(jid, addedBy, note?.trim() || null, new Date().toISOString());
};

export const removeModerator = (jid: string): void => {
  const database = getDb();
  database.prepare<[string]>("DELETE FROM moderators WHERE jid = ?").run(jid);
};

export const isModerator = (jid: string): boolean => {
  const database = getDb();
  const result = database
    .prepare<[string], CountRow>("SELECT COUNT(*) as count FROM moderators WHERE jid = ?")
    .get(jid);

  return (result?.count ?? 0) > 0;
};

export const listModerators = (): Moderator[] => {
  const database = getDb();
  return database
    .prepare<
      [],
      {
        jid: string;
        added_by: string;
        note: string | null;
        added_at: string;
      }
    >(`
      SELECT jid, added_by, note, added_at
      FROM moderators
      ORDER BY added_at ASC
    `)
    .all()
    .map((row) => ({
      jid: row.jid,
      addedBy: row.added_by,
      note: row.note,
      addedAt: row.added_at,
    }));
};
