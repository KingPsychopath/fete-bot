import Database from "better-sqlite3";

import { DATABASE_PATH, ensureStorageDirs } from "./storagePaths.js";

export type LogAction = "DELETED" | "DRY_RUN" | "ERROR" | "WARN";
export type AliasType = "phone" | "lid";
export type AuditResult = "success" | "error" | "pending";
export type ActorRole = "owner" | "moderator";
export type ReviewQueueStatus = "pending" | "resolved";

export type LogEntry = {
  timestamp: string;
  group_jid: string;
  user_id: string;
  participant_jid?: string | null;
  push_name?: string | null;
  message_text?: string | null;
  url_found?: string | null;
  action: LogAction;
  reason?: string | null;
};

export type StrikeGroupRow = {
  group_jid: string;
  count: number;
};

export interface UserRecord {
  id: string;
  createdAt: number;
  displayName: string | null;
  notes: string | null;
  mergedInto: string | null;
}

export interface UserAliasRecord {
  alias: string;
  aliasType: AliasType;
  userId: string;
  firstSeenAt: number;
  lastSeenAt: number;
}

export interface Ban {
  userId: string;
  groupJid: string;
  bannedByUserId: string | null;
  bannedByLabel: string;
  reason: string | null;
  createdAt: string;
}

export interface Mute {
  userId: string;
  groupJid: string;
  mutedByUserId: string | null;
  mutedByLabel: string;
  reason: string | null;
  mutedAt: string;
  expiresAt: string | null;
}

export interface AuditEntry {
  timestamp: string;
  actorUserId: string | null;
  actorJid: string | null;
  actorRole: ActorRole;
  command: string;
  targetUserId: string | null;
  targetJid: string | null;
  groupJid: string | null;
  rawInput: string | null;
  result: AuditResult;
}

export interface Moderator {
  userId: string;
  addedByUserId: string | null;
  addedByLabel: string;
  note: string | null;
  addedAt: string;
}

export interface ReviewQueueEntry {
  userId: string;
  groupJid: string;
  pushName: string | null;
  reason: string;
  messageText: string | null;
  flaggedAt: string;
  status: ReviewQueueStatus;
}

export type ActorReference = {
  userId?: string | null;
  label: string;
};

type CountRow = {
  count: number;
};

const SCHEMA_VERSION = 2;
const RESET_DB_FLAG = "RESET_DB";
export const GLOBAL_MODERATION_GROUP_JID = "__all_groups__";

let db: Database.Database | null = null;

const recreateSchema = (database: Database.Database): void => {
  database.exec("PRAGMA foreign_keys = OFF");

  const tables = [
    "identity_merges",
    "user_aliases",
    "review_queue",
    "audit_log",
    "moderators",
    "mutes",
    "bans",
    "strikes",
    "logs",
    "users",
  ];

  for (const table of tables) {
    database.exec(`DROP TABLE IF EXISTS ${table}`);
  }

  database.exec(`
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      display_name TEXT,
      notes TEXT,
      merged_into TEXT REFERENCES users(id)
    );

    CREATE TABLE user_aliases (
      alias TEXT PRIMARY KEY,
      alias_type TEXT NOT NULL CHECK(alias_type IN ('phone','lid')),
      user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    );
    CREATE INDEX idx_user_aliases_user ON user_aliases(user_id);

    CREATE TABLE identity_merges (
      id TEXT PRIMARY KEY,
      survivor_user_id TEXT NOT NULL REFERENCES users(id),
      merged_user_id TEXT NOT NULL REFERENCES users(id),
      reason TEXT NOT NULL CHECK(reason IN ('alias_collision','metadata_sync','manual_admin')),
      merged_at INTEGER NOT NULL,
      trigger_alias_phone TEXT,
      trigger_alias_lid TEXT
    );
    CREATE INDEX idx_identity_merges_survivor ON identity_merges(survivor_user_id);
    CREATE INDEX idx_identity_merges_merged ON identity_merges(merged_user_id);

    CREATE TABLE logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      group_jid TEXT NOT NULL,
      user_id TEXT NOT NULL,
      participant_jid TEXT,
      push_name TEXT,
      message_text TEXT,
      url_found TEXT,
      action TEXT NOT NULL CHECK(action IN ('DELETED','DRY_RUN','ERROR','WARN')),
      reason TEXT
    );
    CREATE INDEX idx_logs_timestamp ON logs(timestamp);
    CREATE INDEX idx_logs_reason ON logs(reason);

    CREATE TABLE strikes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      group_jid TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX idx_strikes_user_group ON strikes(user_id, group_jid);
    CREATE INDEX idx_strikes_expires ON strikes(expires_at);

    CREATE TABLE bans (
      user_id TEXT NOT NULL REFERENCES users(id),
      group_jid TEXT NOT NULL,
      banned_by_user_id TEXT REFERENCES users(id),
      banned_by_label TEXT NOT NULL,
      reason TEXT,
      created_at TEXT NOT NULL,
      PRIMARY KEY(user_id, group_jid)
    );
    CREATE INDEX idx_bans_group ON bans(group_jid);

    CREATE TABLE mutes (
      user_id TEXT NOT NULL REFERENCES users(id),
      group_jid TEXT NOT NULL,
      muted_by_user_id TEXT REFERENCES users(id),
      muted_by_label TEXT NOT NULL,
      reason TEXT,
      muted_at TEXT NOT NULL,
      expires_at TEXT,
      PRIMARY KEY(user_id, group_jid)
    );
    CREATE INDEX idx_mutes_group ON mutes(group_jid);
    CREATE INDEX idx_mutes_expires ON mutes(expires_at);

    CREATE TABLE moderators (
      user_id TEXT PRIMARY KEY REFERENCES users(id),
      added_by_user_id TEXT REFERENCES users(id),
      added_by_label TEXT NOT NULL,
      note TEXT,
      added_at TEXT NOT NULL
    );

    CREATE TABLE audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT NOT NULL,
      actor_user_id TEXT REFERENCES users(id),
      actor_jid TEXT,
      actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','moderator')),
      command TEXT NOT NULL,
      target_user_id TEXT REFERENCES users(id),
      target_jid TEXT,
      group_jid TEXT,
      raw_input TEXT,
      result TEXT NOT NULL CHECK(result IN ('success','error','pending'))
    );
    CREATE INDEX idx_audit_log_timestamp ON audit_log(timestamp);

    CREATE TABLE review_queue (
      user_id TEXT NOT NULL REFERENCES users(id),
      group_jid TEXT NOT NULL,
      push_name TEXT,
      reason TEXT NOT NULL,
      message_text TEXT,
      flagged_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('pending','resolved')) DEFAULT 'pending',
      PRIMARY KEY(user_id, group_jid)
    );
    CREATE INDEX idx_review_queue_flagged_at ON review_queue(flagged_at);
  `);

  database.pragma(`user_version = ${SCHEMA_VERSION}`);
  database.exec("PRAGMA foreign_keys = ON");
};

const ensureSchema = (database: Database.Database): void => {
  const version = Number(database.pragma("user_version", { simple: true }) ?? 0);
  if (version >= SCHEMA_VERSION) {
    database.pragma("journal_mode = WAL");
    database.exec("PRAGMA foreign_keys = ON");
    return;
  }

  if (process.env[RESET_DB_FLAG] !== "1") {
    throw new Error(
      `Database schema version ${version} is incompatible. Set ${RESET_DB_FLAG}=1 and restart to recreate ${DATABASE_PATH}.`,
    );
  }

  recreateSchema(database);
};

export const initDb = (): void => {
  if (db) {
    return;
  }

  ensureStorageDirs();
  const database = new Database(DATABASE_PATH);
  database.pragma("journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");

  try {
    ensureSchema(database);
    db = database;
  } catch (error) {
    database.close();
    throw error;
  }
};

export const getDb = (): Database.Database => {
  if (!db) {
    throw new Error("Database has not been initialised");
  }

  return db;
};

export const flushDb = (): void => {
  const database = getDb();
  if (database.inTransaction) {
    throw new Error("Cannot flush the database while a transaction is active");
  }

  recreateSchema(database);
};

export const withImmediateTransaction = <T>(fn: () => T): T => {
  const database = getDb();
  if (database.inTransaction) {
    return fn();
  }

  database.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    if (database.inTransaction) {
      database.exec("ROLLBACK");
    }
    throw error;
  }
};

export const closeDb = (): void => {
  if (!db) {
    return;
  }

  db.close();
  db = null;
};

export const getSchemaVersion = (): number => Number(getDb().pragma("user_version", { simple: true }) ?? 0);

export const getUserRecord = (userId: string): UserRecord | null => {
  const row = getDb()
    .prepare<
      [string],
      { id: string; created_at: number; display_name: string | null; notes: string | null; merged_into: string | null }
    >(`
      SELECT id, created_at, display_name, notes, merged_into
      FROM users
      WHERE id = ?
    `)
    .get(userId);

  if (!row) {
    return null;
  }

  return {
    id: row.id,
    createdAt: row.created_at,
    displayName: row.display_name,
    notes: row.notes,
    mergedInto: row.merged_into,
  };
};

export const resolveTerminalUserId = (userId: string, maxDepth = 10): string => {
  let currentUserId = userId;
  const seenUserIds = new Set<string>();

  for (let depth = 0; depth < maxDepth; depth += 1) {
    if (seenUserIds.has(currentUserId)) {
      throw new Error(`Identity merge cycle detected while resolving ${userId}`);
    }

    seenUserIds.add(currentUserId);
    const record = getUserRecord(currentUserId);
    if (!record) {
      throw new Error(`Unknown user_id: ${currentUserId}`);
    }

    if (!record.mergedInto) {
      return currentUserId;
    }

    currentUserId = record.mergedInto;
  }

  throw new Error(`Identity merge chain exceeded max depth for ${userId}`);
};

export const assertUserWritable = (userId: string): string => {
  const terminalUserId = resolveTerminalUserId(userId);
  if (terminalUserId !== userId) {
    throw new Error(`Writes must target terminal user_id ${terminalUserId}, not merged user_id ${userId}`);
  }

  return userId;
};

export const getUserAliases = (userId: string): UserAliasRecord[] => {
  const terminalUserId = resolveTerminalUserId(userId);
  return getDb()
    .prepare<
      [string],
      {
        alias: string;
        alias_type: AliasType;
        user_id: string;
        first_seen_at: number;
        last_seen_at: number;
      }
    >(`
      SELECT alias, alias_type, user_id, first_seen_at, last_seen_at
      FROM user_aliases
      WHERE user_id = ?
      ORDER BY alias ASC
    `)
    .all(terminalUserId)
    .map((row) => ({
      alias: row.alias,
      aliasType: row.alias_type,
      userId: row.user_id,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
    }));
};

export const getIdentityMergesForUser = (userId: string): Array<{
  id: string;
  survivorUserId: string;
  mergedUserId: string;
  reason: string;
  mergedAt: number;
}> =>
  getDb()
    .prepare<
      [string, string],
      {
        id: string;
        survivor_user_id: string;
        merged_user_id: string;
        reason: string;
        merged_at: number;
      }
    >(`
      SELECT id, survivor_user_id, merged_user_id, reason, merged_at
      FROM identity_merges
      WHERE survivor_user_id = ? OR merged_user_id = ?
      ORDER BY merged_at DESC
    `)
    .all(userId, userId)
    .map((row) => ({
      id: row.id,
      survivorUserId: row.survivor_user_id,
      mergedUserId: row.merged_user_id,
      reason: row.reason,
      mergedAt: row.merged_at,
    }));

export const logAction = (entry: LogEntry): void => {
  getDb()
    .prepare<LogEntry>(`
      INSERT INTO logs (
        timestamp,
        group_jid,
        user_id,
        participant_jid,
        push_name,
        message_text,
        url_found,
        action,
        reason
      ) VALUES (
        @timestamp,
        @group_jid,
        @user_id,
        @participant_jid,
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
  getDb().prepare<[string]>("DELETE FROM strikes WHERE expires_at < ?").run(new Date().toISOString());
};

export const getActiveStrikes = (userId: string, groupJid: string): number => {
  const writableUserId = resolveTerminalUserId(userId);
  const result = getDb()
    .prepare<[string, string, string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE user_id = ? AND group_jid = ? AND expires_at > ?
    `)
    .get(writableUserId, groupJid, new Date().toISOString());

  return result?.count ?? 0;
};

export const addStrike = (userId: string, groupJid: string, reason: string, strikeId: string): number => {
  const writableUserId = assertUserWritable(userId);
  const timestamp = new Date();
  const expiresAt = new Date(timestamp.getTime() + 7 * 24 * 60 * 60 * 1000);

  getDb()
    .prepare<[string, string, string, string, string, string]>(`
      INSERT INTO strikes (
        id,
        user_id,
        group_jid,
        reason,
        created_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?)
    `)
    .run(strikeId, writableUserId, groupJid, reason, timestamp.toISOString(), expiresAt.toISOString());

  return getActiveStrikes(writableUserId, groupJid);
};

export const resetStrikes = (userId: string, groupJid: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb().prepare<[string, string]>("DELETE FROM strikes WHERE user_id = ? AND group_jid = ?").run(terminalUserId, groupJid);
};

export const resetAllStrikes = (groupJid?: string): void => {
  if (groupJid) {
    getDb().prepare<[string]>("DELETE FROM strikes WHERE group_jid = ?").run(groupJid);
    return;
  }

  getDb().prepare("DELETE FROM strikes").run();
};

export const getActiveStrikesAcrossGroups = (userId: string): StrikeGroupRow[] => {
  const terminalUserId = resolveTerminalUserId(userId);
  return getDb()
    .prepare<[string, string], StrikeGroupRow>(`
      SELECT group_jid, COUNT(*) as count
      FROM strikes
      WHERE user_id = ? AND expires_at > ?
      GROUP BY group_jid
      ORDER BY group_jid ASC
    `)
    .all(terminalUserId, new Date().toISOString());
};

export const getStrikesIssuedToday = (): number => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const result = getDb()
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE created_at >= ?
    `)
    .get(start.toISOString());

  return result?.count ?? 0;
};

export const getTotalActiveStrikes = (): number => {
  const result = getDb()
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM strikes
      WHERE expires_at > ?
    `)
    .get(new Date().toISOString());

  return result?.count ?? 0;
};

export const removeLatestStrike = (userId: string, groupJid: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb()
    .prepare<[string, string]>(`
      DELETE FROM strikes
      WHERE id = (
        SELECT id
        FROM strikes
        WHERE user_id = ? AND group_jid = ?
        ORDER BY created_at DESC
        LIMIT 1
      )
    `)
    .run(terminalUserId, groupJid);
};

export const addBan = (
  userId: string,
  groupJid: string,
  bannedBy: ActorReference,
  reason?: string,
  createdAt = new Date().toISOString(),
): void => {
  const writableUserId = assertUserWritable(userId);

  getDb()
    .prepare<[string, string, string | null, string, string | null, string]>(`
      INSERT INTO bans (
        user_id,
        group_jid,
        banned_by_user_id,
        banned_by_label,
        reason,
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_jid) DO UPDATE SET
        banned_by_user_id = excluded.banned_by_user_id,
        banned_by_label = excluded.banned_by_label,
        reason = excluded.reason,
        created_at = MIN(bans.created_at, excluded.created_at)
    `)
    .run(writableUserId, groupJid, bannedBy.userId ?? null, bannedBy.label, reason ?? null, createdAt);
};

export const removeBan = (userId: string, groupJid: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb().prepare<[string, string]>("DELETE FROM bans WHERE user_id = ? AND group_jid = ?").run(terminalUserId, groupJid);
};

export const removeAllBans = (groupJid?: string): void => {
  if (groupJid) {
    getDb().prepare<[string]>("DELETE FROM bans WHERE group_jid = ?").run(groupJid);
    return;
  }

  getDb().prepare("DELETE FROM bans").run();
};

export const isBanned = (userId: string, groupJid: string): boolean => {
  const terminalUserId = resolveTerminalUserId(userId);
  const result = getDb()
    .prepare<[string, string, string], CountRow>("SELECT COUNT(*) as count FROM bans WHERE user_id = ? AND group_jid IN (?, ?)")
    .get(terminalUserId, groupJid, GLOBAL_MODERATION_GROUP_JID);

  return (result?.count ?? 0) > 0;
};

export const getBans = (groupJid: string): Ban[] =>
  getDb()
    .prepare<
      [string],
      {
        user_id: string;
        group_jid: string;
        banned_by_user_id: string | null;
        banned_by_label: string;
        reason: string | null;
        created_at: string;
      }
    >(`
      SELECT user_id, group_jid, banned_by_user_id, banned_by_label, reason, created_at
      FROM bans
      WHERE group_jid = ?
      ORDER BY created_at ASC
    `)
    .all(groupJid)
    .map((row) => ({
      userId: row.user_id,
      groupJid: row.group_jid,
      bannedByUserId: row.banned_by_user_id,
      bannedByLabel: row.banned_by_label,
      reason: row.reason,
      createdAt: row.created_at,
    }));

export const getGlobalBans = (): Ban[] => getBans(GLOBAL_MODERATION_GROUP_JID);

export const getBanGroupJids = (): string[] =>
  getDb()
    .prepare<[], { group_jid: string }>(`
      SELECT DISTINCT group_jid
      FROM bans
      ORDER BY group_jid ASC
    `)
    .all()
    .map((row) => row.group_jid);

export const getTotalActiveBans = (): number => {
  const result = getDb().prepare<[], CountRow>("SELECT COUNT(*) as count FROM bans").get();
  return result?.count ?? 0;
};

export const addMute = (
  userId: string,
  groupJid: string,
  mutedBy: ActorReference,
  expiresAt: Date | null,
  reason?: string,
  mutedAt = new Date().toISOString(),
): void => {
  const writableUserId = assertUserWritable(userId);

  getDb()
    .prepare<[string, string, string | null, string, string | null, string, string | null]>(`
      INSERT INTO mutes (
        user_id,
        group_jid,
        muted_by_user_id,
        muted_by_label,
        reason,
        muted_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_jid) DO UPDATE SET
        muted_by_user_id = excluded.muted_by_user_id,
        muted_by_label = excluded.muted_by_label,
        reason = excluded.reason,
        muted_at = MIN(mutes.muted_at, excluded.muted_at),
        expires_at = CASE
          WHEN mutes.expires_at IS NULL OR excluded.expires_at IS NULL THEN NULL
          WHEN mutes.expires_at > excluded.expires_at THEN mutes.expires_at
          ELSE excluded.expires_at
        END
    `)
    .run(
      writableUserId,
      groupJid,
      mutedBy.userId ?? null,
      mutedBy.label,
      reason ?? null,
      mutedAt,
      expiresAt ? expiresAt.toISOString() : null,
    );
};

export const removeMute = (userId: string, groupJid: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb().prepare<[string, string]>("DELETE FROM mutes WHERE user_id = ? AND group_jid = ?").run(terminalUserId, groupJid);
};

export const removeAllMutes = (groupJid?: string): void => {
  if (groupJid) {
    getDb().prepare<[string]>("DELETE FROM mutes WHERE group_jid = ?").run(groupJid);
    return;
  }

  getDb().prepare("DELETE FROM mutes").run();
};

export const isMuted = (userId: string, groupJid: string): boolean => {
  const terminalUserId = resolveTerminalUserId(userId);
  const result = getDb()
    .prepare<[string, string, string, string], CountRow>(`
      SELECT COUNT(*) as count
      FROM mutes
      WHERE user_id = ?
        AND group_jid IN (?, ?)
        AND (expires_at IS NULL OR expires_at > ?)
    `)
    .get(terminalUserId, groupJid, GLOBAL_MODERATION_GROUP_JID, new Date().toISOString());

  return (result?.count ?? 0) > 0;
};

export const getActiveMutes = (groupJid: string): Mute[] =>
  getDb()
    .prepare<
      [string, string],
      {
        user_id: string;
        group_jid: string;
        muted_by_user_id: string | null;
        muted_by_label: string;
        reason: string | null;
        muted_at: string;
        expires_at: string | null;
      }
    >(`
      SELECT user_id, group_jid, muted_by_user_id, muted_by_label, reason, muted_at, expires_at
      FROM mutes
      WHERE group_jid = ?
        AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY muted_at ASC
    `)
    .all(groupJid, new Date().toISOString())
    .map((row) => ({
      userId: row.user_id,
      groupJid: row.group_jid,
      mutedByUserId: row.muted_by_user_id,
      mutedByLabel: row.muted_by_label,
      reason: row.reason,
      mutedAt: row.muted_at,
      expiresAt: row.expires_at,
    }));

export const purgeExpiredMutes = (): void => {
  getDb()
    .prepare<[string]>("DELETE FROM mutes WHERE expires_at IS NOT NULL AND expires_at < ?")
    .run(new Date().toISOString());
};

export const getTotalActiveMutes = (): number => {
  const result = getDb()
    .prepare<[string], CountRow>(`
      SELECT COUNT(*) as count
      FROM mutes
      WHERE expires_at IS NULL OR expires_at > ?
    `)
    .get(new Date().toISOString());

  return result?.count ?? 0;
};

export const logAuditEntry = (entry: AuditEntry): void => {
  getDb()
    .prepare<{
      timestamp: string;
      actorUserId: string | null;
      actorJid: string | null;
      actorRole: ActorRole;
      command: string;
      targetUserId: string | null;
      targetJid: string | null;
      groupJid: string | null;
      rawInput: string | null;
      result: AuditResult;
    }>(`
      INSERT INTO audit_log (
        timestamp,
        actor_user_id,
        actor_jid,
        actor_role,
        command,
        target_user_id,
        target_jid,
        group_jid,
        raw_input,
        result
      ) VALUES (
        @timestamp,
        @actorUserId,
        @actorJid,
        @actorRole,
        @command,
        @targetUserId,
        @targetJid,
        @groupJid,
        @rawInput,
        @result
      )
    `)
    .run(entry);
};

export const getAuditEntries = (limit = 20): AuditEntry[] =>
  getDb()
    .prepare<
      [number],
      {
        timestamp: string;
        actor_user_id: string | null;
        actor_jid: string | null;
        actor_role: ActorRole;
        command: string;
        target_user_id: string | null;
        target_jid: string | null;
        group_jid: string | null;
        raw_input: string | null;
        result: AuditResult;
      }
    >(`
      SELECT timestamp, actor_user_id, actor_jid, actor_role, command, target_user_id, target_jid, group_jid, raw_input, result
      FROM audit_log
      ORDER BY id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => ({
      timestamp: row.timestamp,
      actorUserId: row.actor_user_id,
      actorJid: row.actor_jid,
      actorRole: row.actor_role,
      command: row.command,
      targetUserId: row.target_user_id,
      targetJid: row.target_jid,
      groupJid: row.group_jid,
      rawInput: row.raw_input,
      result: row.result,
    }));

export const getForwardedMessagesSeenToday = (): number => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const result = getDb()
    .prepare<[string, string], CountRow>(`
      SELECT COUNT(*) as count
      FROM logs
      WHERE timestamp >= ? AND reason = ?
    `)
    .get(start.toISOString(), "forwarded message");

  return result?.count ?? 0;
};

export const upsertReviewQueueEntry = (
  userId: string,
  groupJid: string,
  pushName: string | null,
  reason: string,
  messageText: string | null,
  status: ReviewQueueStatus = "pending",
  flaggedAt = new Date().toISOString(),
): void => {
  const writableUserId = assertUserWritable(userId);
  getDb()
    .prepare<[string, string, string | null, string, string | null, string, ReviewQueueStatus]>(`
      INSERT INTO review_queue (
        user_id,
        group_jid,
        push_name,
        reason,
        message_text,
        flagged_at,
        status
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_id, group_jid) DO UPDATE SET
        push_name = excluded.push_name,
        reason = excluded.reason,
        message_text = excluded.message_text,
        flagged_at = MIN(review_queue.flagged_at, excluded.flagged_at),
        status = CASE
          WHEN review_queue.status = 'pending' OR excluded.status = 'pending' THEN 'pending'
          ELSE excluded.status
        END
    `)
    .run(writableUserId, groupJid, pushName, reason, messageText, flaggedAt, status);
};

export const clearReviewQueueEntry = (userId: string, groupJid: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb().prepare<[string, string]>("DELETE FROM review_queue WHERE user_id = ? AND group_jid = ?").run(terminalUserId, groupJid);
};

export const listReviewQueueEntries = (): ReviewQueueEntry[] =>
  getDb()
    .prepare<
      [],
      {
        user_id: string;
        group_jid: string;
        push_name: string | null;
        reason: string;
        message_text: string | null;
        flagged_at: string;
        status: ReviewQueueStatus;
      }
    >(`
      SELECT user_id, group_jid, push_name, reason, message_text, flagged_at, status
      FROM review_queue
      WHERE status = 'pending'
      ORDER BY flagged_at DESC
    `)
    .all()
    .map((row) => ({
      userId: row.user_id,
      groupJid: row.group_jid,
      pushName: row.push_name,
      reason: row.reason,
      messageText: row.message_text,
      flaggedAt: row.flagged_at,
      status: row.status,
    }));

export const addModerator = (userId: string, addedBy: ActorReference, note?: string, addedAt = new Date().toISOString()): void => {
  const writableUserId = assertUserWritable(userId);
  getDb()
    .prepare<[string, string | null, string, string | null, string]>(`
      INSERT INTO moderators (
        user_id,
        added_by_user_id,
        added_by_label,
        note,
        added_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(user_id) DO UPDATE SET
        added_by_user_id = excluded.added_by_user_id,
        added_by_label = excluded.added_by_label,
        note = excluded.note,
        added_at = excluded.added_at
    `)
    .run(writableUserId, addedBy.userId ?? null, addedBy.label, note?.trim() || null, addedAt);
};

export const removeModerator = (userId: string): void => {
  const terminalUserId = resolveTerminalUserId(userId);
  getDb().prepare<[string]>("DELETE FROM moderators WHERE user_id = ?").run(terminalUserId);
};

export const isModeratorUser = (userId: string): boolean => {
  const terminalUserId = resolveTerminalUserId(userId);
  const result = getDb()
    .prepare<[string], CountRow>("SELECT COUNT(*) as count FROM moderators WHERE user_id = ?")
    .get(terminalUserId);

  return (result?.count ?? 0) > 0;
};

export const listModerators = (): Moderator[] =>
  getDb()
    .prepare<
      [],
      {
        user_id: string;
        added_by_user_id: string | null;
        added_by_label: string;
        note: string | null;
        added_at: string;
      }
    >(`
      SELECT user_id, added_by_user_id, added_by_label, note, added_at
      FROM moderators
      ORDER BY added_at ASC
    `)
    .all()
    .map((row) => ({
      userId: row.user_id,
      addedByUserId: row.added_by_user_id,
      addedByLabel: row.added_by_label,
      note: row.note,
      addedAt: row.added_at,
    }));

export const testDbWritable = (): boolean => {
  const timestamp = new Date().toISOString();
  const result = getDb()
    .prepare(`
      INSERT INTO logs (
        timestamp,
        group_jid,
        user_id,
        participant_jid,
        push_name,
        message_text,
        url_found,
        action,
        reason
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(timestamp, "__health__", "__health__", null, "health-check", "health-check", null, "WARN", "health check");

  getDb().prepare("DELETE FROM logs WHERE id = ?").run(Number(result.lastInsertRowid));
  return true;
};
