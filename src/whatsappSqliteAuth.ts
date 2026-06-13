import {
  BufferJSON,
  initAuthCreds,
  proto,
  type AuthenticationCreds,
  type AuthenticationState,
  type SignalDataSet,
  type SignalDataTypeMap,
} from "@whiskeysockets/baileys";

import { getDb, withImmediateTransaction } from "./db.js";
import { log } from "./logger.js";

const AUTH_TABLE_SQL = `
  CREATE TABLE IF NOT EXISTS whatsapp_auth_state (
    type TEXT NOT NULL,
    id TEXT NOT NULL,
    value_json TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (type, id)
  )
`;

const CREDS_TYPE = "creds";
const CREDS_ID = "creds";

type AuthRow = {
  value_json: string;
};

const ensureAuthTable = (): void => {
  getDb().exec(AUTH_TABLE_SQL);
};

const serialiseAuthValue = (value: unknown): string => JSON.stringify(value, BufferJSON.replacer);

const parseAuthValue = <T>(value: string): T => JSON.parse(value, BufferJSON.reviver) as T;

const upsertAuthValue = (type: string, id: string, value: unknown, updatedAt = new Date().toISOString()): void => {
  getDb()
    .prepare<[string, string, string, string]>(`
      INSERT INTO whatsapp_auth_state (type, id, value_json, updated_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(type, id) DO UPDATE SET
        value_json = excluded.value_json,
        updated_at = excluded.updated_at
    `)
    .run(type, id, serialiseAuthValue(value), updatedAt);
};

const deleteAuthValue = (type: string, id: string): void => {
  getDb()
    .prepare<[string, string]>("DELETE FROM whatsapp_auth_state WHERE type = ? AND id = ?")
    .run(type, id);
};

export const getWhatsAppAuthRowsForBackup = (): Array<{
  type: string;
  id: string;
  valueJson: string;
  updatedAt: string;
}> => {
  ensureAuthTable();
  return getDb()
    .prepare<
      [],
      { type: string; id: string; value_json: string; updated_at: string }
    >("SELECT type, id, value_json, updated_at FROM whatsapp_auth_state ORDER BY type, id")
    .all()
    .map((row) => ({
      type: row.type,
      id: row.id,
      valueJson: row.value_json,
      updatedAt: row.updated_at,
    }));
};

export const getWhatsAppAuthCredsForBackup = (): AuthenticationCreds | null => {
  ensureAuthTable();
  const row = getDb()
    .prepare<[string, string], AuthRow>("SELECT value_json FROM whatsapp_auth_state WHERE type = ? AND id = ?")
    .get(CREDS_TYPE, CREDS_ID);

  return row ? parseAuthValue<AuthenticationCreds>(row.value_json) : null;
};

export const clearWhatsAppAuthState = (): void => {
  ensureAuthTable();
  getDb().prepare("DELETE FROM whatsapp_auth_state").run();
};

export const useSqliteAuthState = async (): Promise<{
  state: AuthenticationState;
  saveCreds: () => Promise<void>;
}> => {
  ensureAuthTable();
  const existingCreds = getWhatsAppAuthCredsForBackup();
  const creds = existingCreds ?? initAuthCreds();

  if (!existingCreds) {
    upsertAuthValue(CREDS_TYPE, CREDS_ID, creds);
    log("Initialised new WhatsApp SQLite auth credentials");
  }

  return {
    state: {
      creds,
      keys: {
        get: <T extends keyof SignalDataTypeMap>(type: T, ids: string[]) => {
          const statement = getDb()
            .prepare<[string, string], AuthRow>("SELECT value_json FROM whatsapp_auth_state WHERE type = ? AND id = ?");
          const data: { [id: string]: SignalDataTypeMap[T] } = {};

          for (const id of ids) {
            const row = statement.get(type, id);
            if (!row) {
              continue;
            }

            let value = parseAuthValue<SignalDataTypeMap[T]>(row.value_json);
            if (type === "app-state-sync-key" && value) {
              value = proto.Message.AppStateSyncKeyData.fromObject(
                value as Record<string, unknown>,
              ) as unknown as SignalDataTypeMap[T];
            }
            data[id] = value;
          }

          return data;
        },
        set: (data: SignalDataSet) => {
          withImmediateTransaction(() => {
            const updatedAt = new Date().toISOString();
            for (const [type, entries] of Object.entries(data)) {
              if (!entries) {
                continue;
              }

              for (const [id, value] of Object.entries(entries)) {
                if (value === null) {
                  deleteAuthValue(type, id);
                } else {
                  upsertAuthValue(type, id, value, updatedAt);
                }
              }
            }
          });
        },
      },
    },
    saveCreds: async () => {
      upsertAuthValue(CREDS_TYPE, CREDS_ID, creds);
    },
  };
};
