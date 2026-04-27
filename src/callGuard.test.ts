import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

let tempDir: string;
let previousDbPath: string | undefined;
let previousResetDb: string | undefined;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-call-guard-"));
  previousDbPath = process.env.DB_PATH;
  previousResetDb = process.env.RESET_DB;
  process.env.DB_PATH = path.join(tempDir, "bot.db");
  process.env.RESET_DB = "1";
});

afterEach(async () => {
  const db = await import("./db.js");
  db.closeDb();
  if (previousDbPath === undefined) {
    delete process.env.DB_PATH;
  } else {
    process.env.DB_PATH = previousDbPath;
  }
  if (previousResetDb === undefined) {
    delete process.env.RESET_DB;
  } else {
    process.env.RESET_DB = previousResetDb;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("call guard persistence", () => {
  it("inserts before counting active violations inside the window", async () => {
    const db = await import("./db.js");
    const { resolveUser } = await import("./identity.js");
    db.initDb();

    const user = await resolveUser({ participantJid: "123@lid" });
    expect(user).not.toBeNull();

    const firstCount = db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-1", 1_000, 60_000);
    const secondCount = db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-2", 2_000, 60_000);

    expect(firstCount).toBe(1);
    expect(secondCount).toBe(2);
  });

  it("does not count violations outside the configured window", async () => {
    const db = await import("./db.js");
    const { resolveUser } = await import("./identity.js");
    db.initDb();

    const user = await resolveUser({ participantJid: "123@lid" });
    expect(user).not.toBeNull();

    db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-1", 1_000, 1_000);
    const activeCount = db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-2", 3_000, 1_000);

    expect(activeCount).toBe(1);
  });

  it("clears call violations for the canonical user", async () => {
    const db = await import("./db.js");
    const { resolveUser } = await import("./identity.js");
    db.initDb();

    const user = await resolveUser({
      participantJid: "123:45@lid",
      lidJid: "123@lid",
      phoneJid: "447911123456@s.whatsapp.net",
    });
    expect(user).not.toBeNull();

    db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-1", 1_000, 60_000);
    expect(db.clearCallViolations(user!.userId, "group@g.us")).toBe(1);
    expect(db.getActiveCallViolations(user!.userId, "group@g.us", 2_000, 60_000)).toBe(0);
  });

  it("keeps violations when removal failure is audited", async () => {
    const db = await import("./db.js");
    const { resolveUser } = await import("./identity.js");
    db.initDb();

    const user = await resolveUser({ participantJid: "123@lid" });
    expect(user).not.toBeNull();

    db.addCallViolationAndCountActive(user!.userId, "group@g.us", "call-1", 1_000, 60_000);
    db.logCallGuardAudit({
      callId: "call-1",
      userId: user!.userId,
      rawCallerJid: "123@lid",
      groupJid: "group@g.us",
      inferred: false,
      action: "remove_fail",
      detail: "not_admin",
      createdAt: 1_000,
    });

    expect(db.getActiveCallViolations(user!.userId, "group@g.us", 2_000, 60_000)).toBe(1);
    expect(db.getDb().prepare("SELECT action, detail FROM call_guard_audit").all()).toEqual([
      { action: "remove_fail", detail: "not_admin" },
    ]);
  });
});
