import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { migrateSchemaV2ToV3 } from "../../../db.js";

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
