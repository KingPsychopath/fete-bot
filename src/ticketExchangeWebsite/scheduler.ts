import type { WASocket } from "@whiskeysockets/baileys";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { Config } from "../config.js";
import { getDebugRedirectSwitchState } from "../debugRedirectSwitch.js";
import { log, warn } from "../logger.js";
import { isQuietSwitchEnabled } from "../quietSwitch.js";
import { DATA_DIR } from "../storagePaths.js";
import {
  fetchWebsiteTicketExchangeListings,
  isWebsiteTicketExchangeListingAnnounceable,
  markWebsiteTicketExchangeListingAnnounced,
} from "./client.js";
import { buildWebsiteTicketExchangeAnnouncement } from "./format.js";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;
let targetStatePath = join(DATA_DIR, "ticket-exchange-announcement-targets.json");

type AnnouncementTargetState = Record<string, Record<string, string>>;

const readAnnouncementTargetState = (): AnnouncementTargetState => {
  try {
    if (!existsSync(targetStatePath)) {
      return {};
    }

    const parsed = JSON.parse(readFileSync(targetStatePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    const state: AnnouncementTargetState = {};
    for (const [listingId, targets] of Object.entries(parsed)) {
      if (!targets || typeof targets !== "object" || Array.isArray(targets)) {
        continue;
      }

      const targetState: Record<string, string> = {};
      for (const [targetJid, sentAt] of Object.entries(targets)) {
        if (typeof sentAt === "string") {
          targetState[targetJid] = sentAt;
        }
      }
      state[listingId] = targetState;
    }
    return state;
  } catch (stateError) {
    warn("ticket_exchange.website_announcement.target_state_read_failed", {
      path: targetStatePath,
      error: stateError,
    });
    return {};
  }
};

const writeAnnouncementTargetState = (state: AnnouncementTargetState): void => {
  try {
    mkdirSync(dirname(targetStatePath), { recursive: true });
    writeFileSync(targetStatePath, `${JSON.stringify(state, null, 2)}\n`);
  } catch (stateError) {
    warn("ticket_exchange.website_announcement.target_state_write_failed", {
      path: targetStatePath,
      error: stateError,
    });
  }
};

const hasListingTargetBeenSent = (
  state: AnnouncementTargetState,
  listingId: string,
  targetJid: string,
): boolean => Boolean(state[listingId]?.[targetJid]);

const recordListingTargetSent = (
  state: AnnouncementTargetState,
  listingId: string,
  targetJid: string,
  sentAt = new Date(),
): void => {
  state[listingId] ??= {};
  state[listingId][targetJid] = sentAt.toISOString();
  writeAnnouncementTargetState(state);
};

const clearListingTargetState = (state: AnnouncementTargetState, listingId: string): void => {
  if (!(listingId in state)) {
    return;
  }

  delete state[listingId];
  writeAnnouncementTargetState(state);
};

export const setWebsiteTicketExchangeAnnouncementTargetStatePathForTests = (path: string): void => {
  targetStatePath = path;
};

const getEnabledTargetJids = (config: Config): string[] =>
  Array.from(
    new Set(
      config.ticketExchangeWebsiteTargetJids
        .map((jid) => jid.trim())
        .filter((jid) => jid.endsWith("@g.us")),
    ),
  );

const hasRequiredConfig = (config: Config): boolean =>
  Boolean(
    config.ticketExchangeWebsiteAnnouncementsEnabled &&
      config.ticketExchangeWebsiteBaseUrl &&
      config.ticketExchangeWebsiteBotSecret &&
      getEnabledTargetJids(config).length > 0,
  );

export const isWebsiteTicketExchangeListingPastAnnounceDelay = (
  createdAt: string,
  delayMinutes: number,
  now = new Date(),
): boolean => {
  const createdAtDate = new Date(createdAt);
  if (!Number.isFinite(createdAtDate.getTime())) {
    return true;
  }

  return now.getTime() - createdAtDate.getTime() >= Math.max(0, delayMinutes) * 60 * 1000;
};

export const runWebsiteTicketExchangeAnnouncementTick = async (
  sock: WASocket,
  config: Config,
): Promise<void> => {
  if (!hasRequiredConfig(config) || schedulerRunning) {
    return;
  }

  if (isQuietSwitchEnabled()) {
    log("ticket_exchange.website_announcement.skipped_quiet_switch");
    return;
  }

  schedulerRunning = true;
  try {
    const targetJids = getEnabledTargetJids(config);
    const debugRedirectEnabled = getDebugRedirectSwitchState().enabled;
    const targetState = readAnnouncementTargetState();
    const listings = await fetchWebsiteTicketExchangeListings({
      baseUrl: config.ticketExchangeWebsiteBaseUrl,
      secret: config.ticketExchangeWebsiteBotSecret,
      limit: config.ticketExchangeWebsiteBatchSize,
    });
    let announcedThisTick = 0;
    const maxAnnouncementsThisTick = Math.max(1, config.ticketExchangeWebsiteMaxAnnouncementsPerTick);

    for (const listing of listings) {
      if (announcedThisTick >= maxAnnouncementsThisTick) {
        log("ticket_exchange.website_announcement.tick_limit_reached", {
          announcedThisTick,
          maxAnnouncementsThisTick,
        });
        break;
      }

      if (!isWebsiteTicketExchangeListingPastAnnounceDelay(
        listing.createdAt,
        config.ticketExchangeWebsiteAnnounceDelayMinutes,
      )) {
        log("ticket_exchange.website_announcement.skipped_delay", {
          listingId: listing.id,
          createdAt: listing.createdAt,
          delayMinutes: config.ticketExchangeWebsiteAnnounceDelayMinutes,
        });
        continue;
      }

      try {
        const announceable = await isWebsiteTicketExchangeListingAnnounceable({
          baseUrl: config.ticketExchangeWebsiteBaseUrl,
          secret: config.ticketExchangeWebsiteBotSecret,
          listingId: listing.id,
        });
        if (!announceable) {
          log("ticket_exchange.website_announcement.skipped_stale", {
            listingId: listing.id,
          });
          continue;
        }
      } catch (statusError) {
        warn("ticket_exchange.website_announcement.status_check_failed", {
          listingId: listing.id,
          error: statusError,
        });
        continue;
      }

      const message = buildWebsiteTicketExchangeAnnouncement(
        config.ticketExchangeWebsiteBaseUrl,
        listing,
      );
      let sentCount = 0;
      let failedCount = 0;
      let skippedAlreadySentCount = 0;

      for (const targetJid of targetJids) {
        if (!debugRedirectEnabled && hasListingTargetBeenSent(targetState, listing.id, targetJid)) {
          skippedAlreadySentCount += 1;
          log("ticket_exchange.website_announcement.skipped_target_already_sent", {
            listingId: listing.id,
            targetJid,
          });
          continue;
        }

        if (config.dryRun) {
          warn("Dry run: would announce website Ticket Exchange listing", {
            listingId: listing.id,
            targetJid,
            message,
          });
          continue;
        }

        try {
          await sock.sendMessage(targetJid, { text: message });
          sentCount += 1;
          if (!debugRedirectEnabled) {
            recordListingTargetSent(targetState, listing.id, targetJid);
          }
          log("ticket_exchange.website_announcement.sent", {
            listingId: listing.id,
            targetJid,
          });
        } catch (sendError) {
          failedCount += 1;
          warn("ticket_exchange.website_announcement.send_failed", {
            listingId: listing.id,
            targetJid,
            error: sendError,
          });
        }
      }

      const allTargetsSent = !config.dryRun && !debugRedirectEnabled &&
        targetJids.every((targetJid) => hasListingTargetBeenSent(targetState, listing.id, targetJid));

      if (sentCount > 0 || allTargetsSent) {
        if (failedCount > 0) {
          warn("ticket_exchange.website_announcement.not_marked_partial_send", {
            listingId: listing.id,
            sentCount,
            skippedAlreadySentCount,
            failedCount,
            targetCount: targetJids.length,
          });
          continue;
        }

        if (debugRedirectEnabled) {
          log("ticket_exchange.website_announcement.debug_preview_not_marked", {
            listingId: listing.id,
          });
          announcedThisTick += 1;
          continue;
        }

        try {
          await markWebsiteTicketExchangeListingAnnounced({
            baseUrl: config.ticketExchangeWebsiteBaseUrl,
            secret: config.ticketExchangeWebsiteBotSecret,
            listingId: listing.id,
          });
          clearListingTargetState(targetState, listing.id);
          announcedThisTick += 1;
        } catch (callbackError) {
          warn("ticket_exchange.website_announcement.callback_failed", {
            listingId: listing.id,
            error: callbackError,
          });
        }
      }
    }
  } catch (schedulerError) {
    warn("Website Ticket Exchange announcement tick failed", schedulerError);
  } finally {
    schedulerRunning = false;
  }
};

export const startWebsiteTicketExchangeAnnouncementScheduler = (
  sock: WASocket,
  config: Config,
): void => {
  if (!hasRequiredConfig(config) || schedulerTimer) {
    if (config.ticketExchangeWebsiteAnnouncementsEnabled) {
      warn("Website Ticket Exchange announcements are enabled but not fully configured", {
        hasBaseUrl: Boolean(config.ticketExchangeWebsiteBaseUrl),
        hasSecret: Boolean(config.ticketExchangeWebsiteBotSecret),
        targetCount: getEnabledTargetJids(config).length,
      });
    }
    return;
  }

  schedulerTimer = setInterval(() => {
    void runWebsiteTicketExchangeAnnouncementTick(sock, config);
  }, Math.max(30, config.ticketExchangeWebsitePollSeconds) * 1000);
  schedulerTimer.unref();

  void runWebsiteTicketExchangeAnnouncementTick(sock, config);
};

export const stopWebsiteTicketExchangeAnnouncementScheduler = (): void => {
  if (!schedulerTimer) {
    return;
  }
  clearInterval(schedulerTimer);
  schedulerTimer = null;
};
