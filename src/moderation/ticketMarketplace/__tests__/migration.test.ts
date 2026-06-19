import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  migrateSchemaV2ToV3,
  migrateSchemaV3ToV4,
  migrateSchemaV4ToV5,
  migrateSchemaV5ToV6,
  migrateSchemaV6ToV7,
  migrateSchemaV7ToV8,
} from "../../../db.js";

let tempDir: string | null = null;

const createV2Database = (): Database.Database => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-migration-"));
  const database = new Database(path.join(tempDir, "bot.db"));
  database.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      display_name TEXT,
      notes TEXT,
      merged_into TEXT REFERENCES users(id)
    );
    CREATE TABLE strikes (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL REFERENCES users(id),
      group_jid TEXT NOT NULL,
      reason TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    INSERT INTO users (id, created_at, display_name, notes, merged_into)
    VALUES ('user-1', 1, 'User One', NULL, NULL);
    INSERT INTO strikes (id, user_id, group_jid, reason, created_at, expires_at)
    VALUES ('strike-1', 'user-1', 'group@g.us', 'test', '2026-04-24T00:00:00.000Z', '2026-05-01T00:00:00.000Z');
    PRAGMA user_version = 2;
  `);
  return database;
};

afterEach(() => {
  if (tempDir) {
    rmSync(tempDir, { recursive: true, force: true });
    tempDir = null;
  }
});

describe("v2 to v3 migration", () => {
  it("preserves existing data and creates spotlight tables", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(3);
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM strikes").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spotlight_pending'").get()).toEqual({
        name: "spotlight_pending",
      });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spotlight_history'").get()).toEqual({
        name: "spotlight_history",
      });
    } finally {
      database.close();
    }
  });

  it("rolls back a failed migration without half-created tables", () => {
    const database = createV2Database();
    try {
      expect(() => migrateSchemaV2ToV3(database, { throwAfterSchemaForTest: true })).toThrow("Intentional migration failure");

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(2);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'spotlight_pending'").get()).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

describe("v3 to v4 migration", () => {
  it("creates announcement tables without touching existing data", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(4);
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM strikes").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'announcement_queue_items'").get()).toEqual({
        name: "announcement_queue_items",
      });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'announcement_cycle_items'").get()).toEqual({
        name: "announcement_cycle_items",
      });
    } finally {
      database.close();
    }
  });
});

describe("v4 to v5 migration", () => {
  it("creates call guard tables without touching existing data", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);
      migrateSchemaV4ToV5(database);

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(5);
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM strikes").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_violations'").get()).toEqual({
        name: "call_violations",
      });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'call_guard_audit'").get()).toEqual({
        name: "call_guard_audit",
      });
    } finally {
      database.close();
    }
  });
});

describe("v6 to v7 migration", () => {
  it("creates durable cleanup removal queue tables without touching existing data", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);
      migrateSchemaV4ToV5(database);
      migrateSchemaV5ToV6(database);
      migrateSchemaV6ToV7(database);

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(7);
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT COUNT(*) AS count FROM strikes").get()).toEqual({ count: 1 });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_removal_jobs'").get()).toEqual({
        name: "cleanup_removal_jobs",
      });
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_removal_actions'").get()).toEqual({
        name: "cleanup_removal_actions",
      });
    } finally {
      database.close();
    }
  });

  it("rolls back a failed cleanup removal queue migration", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);
      migrateSchemaV4ToV5(database);
      migrateSchemaV5ToV6(database);

      expect(() => migrateSchemaV6ToV7(database, { throwAfterSchemaForTest: true })).toThrow("Intentional migration failure");

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(6);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_removal_jobs'").get()).toBeUndefined();
      expect(database.prepare("SELECT COUNT(*) AS count FROM users").get()).toEqual({ count: 1 });
    } finally {
      database.close();
    }
  });
});

describe("v7 to v8 migration", () => {
  it("adds group join observations and preserves cleanup signals", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);
      migrateSchemaV4ToV5(database);
      migrateSchemaV5ToV6(database);
      database.exec(`
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
        ) VALUES (
          'campaign-1',
          'active',
          1,
          1000,
          'user-1',
          'owner',
          NULL,
          'public',
          'dm',
          25,
          30,
          1,
          1,
          1
        );
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
        ) VALUES (
          'campaign-1',
          'user-1',
          'User One',
          '447700900001@s.whatsapp.net',
          'group@g.us',
          2,
          'group_activity',
          2,
          'skipped',
          1,
          2
        );
        INSERT INTO cleanup_signals (
          campaign_id,
          user_id,
          signal_type,
          source_jid,
          message_id,
          created_at
        ) VALUES (
          'campaign-1',
          'user-1',
          'group_activity',
          'group@g.us',
          'msg-1',
          2
        );
      `);
      migrateSchemaV6ToV7(database);
      migrateSchemaV7ToV8(database);

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(8);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'group_member_joins'").get()).toEqual({
        name: "group_member_joins",
      });
      expect(database.prepare("SELECT signal_type FROM cleanup_signals").all()).toEqual([
        { signal_type: "group_activity" },
      ]);
      expect(() => database.prepare(`
        INSERT INTO cleanup_signals (
          campaign_id,
          user_id,
          signal_type,
          source_jid,
          message_id,
          created_at
        ) VALUES (
          'campaign-1',
          'user-1',
          'group_join',
          'group@g.us',
          NULL,
          3
        )
      `).run()).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("rolls back a failed group join migration", () => {
    const database = createV2Database();
    try {
      migrateSchemaV2ToV3(database);
      migrateSchemaV3ToV4(database);
      migrateSchemaV4ToV5(database);
      migrateSchemaV5ToV6(database);
      migrateSchemaV6ToV7(database);

      expect(() => migrateSchemaV7ToV8(database, { throwAfterSchemaForTest: true })).toThrow("Intentional migration failure");

      expect(Number(database.pragma("user_version", { simple: true }))).toBe(7);
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_signals_old'").get()).toBeUndefined();
      expect(database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'cleanup_signals'").get()).toEqual({
        name: "cleanup_signals",
      });
    } finally {
      database.close();
    }
  });
});
