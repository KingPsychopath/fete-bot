import type { WASocket } from "@whiskeysockets/baileys";

import type { Config } from "../config.js";
import { getDebugRedirectSwitchState } from "../debugRedirectSwitch.js";
import { log, warn } from "../logger.js";
import { isQuietSwitchEnabled } from "../quietSwitch.js";
import {
  fetchWebsiteTicketExchangeListings,
  isWebsiteTicketExchangeListingAnnounceable,
  markWebsiteTicketExchangeListingAnnounced,
} from "./client.js";
import { buildWebsiteTicketExchangeAnnouncement } from "./format.js";

let schedulerTimer: ReturnType<typeof setInterval> | null = null;
let schedulerRunning = false;

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
    const listings = await fetchWebsiteTicketExchangeListings({
      baseUrl: config.ticketExchangeWebsiteBaseUrl,
      secret: config.ticketExchangeWebsiteBotSecret,
      limit: config.ticketExchangeWebsiteBatchSize,
    });

    for (const listing of listings) {
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

      for (const targetJid of targetJids) {
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

      if (sentCount > 0) {
        if (failedCount > 0) {
          warn("ticket_exchange.website_announcement.not_marked_partial_send", {
            listingId: listing.id,
            sentCount,
            failedCount,
            targetCount: targetJids.length,
          });
          continue;
        }

        if (debugRedirectEnabled) {
          log("ticket_exchange.website_announcement.debug_preview_not_marked", {
            listingId: listing.id,
          });
          continue;
        }

        try {
          await markWebsiteTicketExchangeListingAnnounced({
            baseUrl: config.ticketExchangeWebsiteBaseUrl,
            secret: config.ticketExchangeWebsiteBotSecret,
            listingId: listing.id,
          });
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
