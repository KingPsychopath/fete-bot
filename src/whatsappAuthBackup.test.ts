import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { createWhatsAppAuthBackup } from "./whatsappAuthBackup.js";

const makeDirs = () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "fete-bot-auth-backup-"));
  const authDir = path.join(dataDir, "auth");
  return { dataDir, authDir };
};

const writeEmptyAuthDir = (authDir: string) => {
  rmSync(authDir, { recursive: true, force: true });
  mkdirSync(authDir, { recursive: true });
  writeFileSync(path.join(authDir, ".keep"), "", { flag: "w" });
};

const writeLinkedCreds = (authDir: string, id = "447343073599@s.whatsapp.net") => {
  rmSync(authDir, { recursive: true, force: true });
  mkdirSync(authDir, { recursive: true });
  writeFileSync(path.join(authDir, "creds.json"), JSON.stringify({ registered: false, me: { id } }));
};

describe("WhatsApp auth backups", () => {
  it("creates a timestamped backup containing auth files and a manifest", () => {
    const { dataDir, authDir } = makeDirs();
    writeLinkedCreds(authDir);

    const result = createWhatsAppAuthBackup({
      dataDir,
      authDir,
      now: new Date("2026-05-28T18:15:00.000Z"),
    });

    expect(result.created).toBe(true);
    if (!result.created) {
      throw new Error("expected backup to be created");
    }
    expect(result.backupName).toBe("20260528T181500Z-447343073599@s.whatsapp.net");
    expect(existsSync(path.join(result.backupPath, "auth", "creds.json"))).toBe(true);
    expect(existsSync(path.join(result.backupPath, "manifest.json"))).toBe(true);
  });

  it("does not create a backup when creds are missing", () => {
    const { dataDir, authDir } = makeDirs();
    writeEmptyAuthDir(authDir);

    expect(createWhatsAppAuthBackup({ dataDir, authDir })).toEqual({
      created: false,
      reason: "missing-creds",
    });
  });

  it("retries later when creds are still being written", () => {
    const { dataDir, authDir } = makeDirs();
    rmSync(authDir, { recursive: true, force: true });
    mkdirSync(authDir, { recursive: true });
    writeFileSync(path.join(authDir, "creds.json"), "");

    expect(createWhatsAppAuthBackup({ dataDir, authDir })).toEqual({
      created: false,
      reason: "creds-not-ready",
    });
  });

  it("prunes older backups after the configured retention count", () => {
    const { dataDir, authDir } = makeDirs();
    writeLinkedCreds(authDir);

    const first = createWhatsAppAuthBackup({
      dataDir,
      authDir,
      now: new Date("2026-05-28T18:15:00.000Z"),
      maxBackups: 2,
    });
    const second = createWhatsAppAuthBackup({
      dataDir,
      authDir,
      now: new Date("2026-05-28T18:16:00.000Z"),
      maxBackups: 2,
    });
    const third = createWhatsAppAuthBackup({
      dataDir,
      authDir,
      now: new Date("2026-05-28T18:17:00.000Z"),
      maxBackups: 2,
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(third.created).toBe(true);
    if (!third.created || !first.created) {
      throw new Error("expected backups to be created");
    }
    expect(third.removedBackupNames).toEqual([first.backupName]);
  });
});
