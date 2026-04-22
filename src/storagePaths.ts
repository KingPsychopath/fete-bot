import { cpSync, existsSync, mkdirSync, renameSync } from "node:fs";
import path from "node:path";

const DEFAULT_DATA_DIR = path.resolve(process.cwd(), "data");

export const DATA_DIR = DEFAULT_DATA_DIR;
export const DATABASE_PATH = process.env.DB_PATH ?? path.join(DEFAULT_DATA_DIR, "bot.db");
export const AUTH_DIR = process.env.AUTH_FOLDER ?? path.join(DEFAULT_DATA_DIR, "auth");

const LEGACY_AUTH_DIR = path.resolve(process.cwd(), "auth");

export function ensureStorageDirs(): void {
  mkdirSync(path.dirname(DATABASE_PATH), { recursive: true });
  mkdirSync(AUTH_DIR, { recursive: true });
}

export function migrateLegacyAuthDir(): void {
  if (!existsSync(LEGACY_AUTH_DIR) || existsSync(AUTH_DIR)) {
    return;
  }

  mkdirSync(path.dirname(AUTH_DIR), { recursive: true });

  try {
    renameSync(LEGACY_AUTH_DIR, AUTH_DIR);
  } catch {
    // Fall back to copying when the legacy directory lives on another filesystem.
    cpSync(LEGACY_AUTH_DIR, AUTH_DIR, { recursive: true });
  }
}
