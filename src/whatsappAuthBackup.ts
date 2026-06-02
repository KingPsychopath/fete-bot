import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

export type WhatsAppAuthBackupResult =
  | {
      created: true;
      backupPath: string;
      backupName: string;
      linkedIdentity: string;
      removedBackupNames: string[];
    }
  | {
      created: false;
      reason: "missing-creds" | "creds-not-ready" | "missing-linked-identity" | "backup-exists";
      backupPath?: string;
      backupName?: string;
    };

type WhatsAppCredsFile = {
  registered?: boolean;
  platform?: string;
  me?: {
    id?: string | null;
    lid?: string | null;
    name?: string | null;
  } | null;
};

type CreateWhatsAppAuthBackupOptions = {
  dataDir: string;
  authDir: string;
  now?: Date;
  backupName?: string;
  maxBackups?: number;
};

const BACKUP_ROOT_NAME = "auth-backups";

const parseMaxBackups = (value: string | undefined, fallback: number): number => {
  if (!value?.trim()) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const DEFAULT_MAX_BACKUPS = parseMaxBackups(process.env.WHATSAPP_AUTH_MAX_BACKUPS, 1);

const formatTimestamp = (date: Date): string =>
  date
    .toISOString()
    .replace(/\.\d{3}Z$/u, "Z")
    .replace(/[-:]/gu, "");

const sanitiseBackupPart = (value: string): string => value.replace(/[^0-9A-Za-z_.@:-]/gu, "_");

const readCreds = (credsPath: string): WhatsAppCredsFile | null => {
  try {
    return JSON.parse(readFileSync(credsPath, "utf8")) as WhatsAppCredsFile;
  } catch (readError) {
    if (readError instanceof SyntaxError) {
      return null;
    }

    throw readError;
  }
};

const getBackupNames = (backupRoot: string): string[] => {
  if (!existsSync(backupRoot)) {
    return [];
  }

  return readdirSync(backupRoot).filter((name) => {
    if (name.includes(".tmp-")) {
      return false;
    }

    const backupPath = path.join(backupRoot, name);
    return statSync(backupPath).isDirectory();
  });
};

const removeStaleTmpBackups = (backupRoot: string): void => {
  if (!existsSync(backupRoot)) {
    return;
  }

  for (const name of readdirSync(backupRoot)) {
    if (name.includes(".tmp-")) {
      rmSync(path.join(backupRoot, name), { recursive: true, force: true });
    }
  }
};

const pruneBackups = (backupRoot: string, maxBackups: number): string[] => {
  if (maxBackups < 1) {
    return [];
  }

  const backupNames = getBackupNames(backupRoot).sort().reverse();
  const staleBackupNames = backupNames.slice(maxBackups);

  for (const name of staleBackupNames) {
    rmSync(path.join(backupRoot, name), { recursive: true, force: true });
  }

  return staleBackupNames;
};

export const createWhatsAppAuthBackup = ({
  dataDir,
  authDir,
  now = new Date(),
  backupName,
  maxBackups = DEFAULT_MAX_BACKUPS,
}: CreateWhatsAppAuthBackupOptions): WhatsAppAuthBackupResult => {
  const credsPath = path.join(authDir, "creds.json");
  if (!existsSync(credsPath)) {
    return { created: false, reason: "missing-creds" };
  }

  const creds = readCreds(credsPath);
  if (!creds) {
    return { created: false, reason: "creds-not-ready" };
  }
  const linkedIdentity = creds.me?.id || creds.me?.lid;
  if (!linkedIdentity?.trim()) {
    return { created: false, reason: "missing-linked-identity" };
  }

  const backupRoot = path.join(dataDir, BACKUP_ROOT_NAME);
  mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
  removeStaleTmpBackups(backupRoot);

  const name = backupName ?? `${formatTimestamp(now)}-${sanitiseBackupPart(linkedIdentity)}`;
  const backupPath = path.join(backupRoot, name);
  if (existsSync(backupPath)) {
    return { created: false, reason: "backup-exists", backupPath, backupName: name };
  }

  const tmpPath = `${backupPath}.tmp-${process.pid}`;
  rmSync(tmpPath, { recursive: true, force: true });
  mkdirSync(tmpPath, { recursive: true, mode: 0o700 });

  try {
    cpSync(authDir, path.join(tmpPath, "auth"), { recursive: true });
    writeFileSync(
      path.join(tmpPath, "manifest.json"),
      `${JSON.stringify(
        {
          createdAt: now.toISOString(),
          authDir,
          me: creds.me ?? null,
          registered: creds.registered ?? null,
          platform: creds.platform ?? null,
          format: "auth-directory-v1",
        },
        null,
        2,
      )}\n`,
    );
    renameSync(tmpPath, backupPath);
  } catch (backupError) {
    rmSync(tmpPath, { recursive: true, force: true });
    throw backupError;
  }

  const removedBackupNames = pruneBackups(backupRoot, maxBackups);
  return {
    created: true,
    backupPath,
    backupName: name,
    linkedIdentity,
    removedBackupNames,
  };
};
