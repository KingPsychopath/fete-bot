import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "./storagePaths.js";

const TICKET_MARKETPLACE_DELETION_PATH = join(DATA_DIR, "ticket-marketplace-deletion.json");

export type TicketMarketplaceDeletionState = {
  enabled: boolean;
  updatedAt: string;
  updatedBy: string | null;
};

const defaultState = (): TicketMarketplaceDeletionState => ({
  enabled: false,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
});

const readTicketMarketplaceDeletionState = (): TicketMarketplaceDeletionState => {
  if (!existsSync(TICKET_MARKETPLACE_DELETION_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(
      readFileSync(TICKET_MARKETPLACE_DELETION_PATH, "utf8"),
    ) as Partial<TicketMarketplaceDeletionState>;
    return {
      enabled: parsed.enabled === true,
      updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : defaultState().updatedAt,
      updatedBy: typeof parsed.updatedBy === "string" ? parsed.updatedBy : null,
    };
  } catch {
    return defaultState();
  }
};

export const getTicketMarketplaceDeletionState = (): TicketMarketplaceDeletionState =>
  readTicketMarketplaceDeletionState();

export const isTicketMarketplaceDeletionEnabled = (): boolean =>
  readTicketMarketplaceDeletionState().enabled;

export const setTicketMarketplaceDeletionEnabled = (
  enabled: boolean,
  updatedBy: string | null,
): TicketMarketplaceDeletionState => {
  ensureStorageDirs();
  const state: TicketMarketplaceDeletionState = {
    enabled,
    updatedAt: new Date().toISOString(),
    updatedBy,
  };
  const tempPath = `${TICKET_MARKETPLACE_DELETION_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, TICKET_MARKETPLACE_DELETION_PATH);
  return state;
};
