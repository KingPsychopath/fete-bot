import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "../storagePaths.js";

const WEBSITE_VISIBILITY_PROMPT_STATE_PATH = join(DATA_DIR, "ticket-exchange-visibility-prompts.json");

type WebsiteVisibilityPromptState = {
  promptedByUserId: Record<string, string>;
};

const defaultState = (): WebsiteVisibilityPromptState => ({ promptedByUserId: {} });

const readState = (): WebsiteVisibilityPromptState => {
  if (!existsSync(WEBSITE_VISIBILITY_PROMPT_STATE_PATH)) {
    return defaultState();
  }

  try {
    const parsed = JSON.parse(readFileSync(WEBSITE_VISIBILITY_PROMPT_STATE_PATH, "utf8")) as Partial<WebsiteVisibilityPromptState>;
    const promptedByUserId = parsed.promptedByUserId && typeof parsed.promptedByUserId === "object"
      ? Object.fromEntries(
        Object.entries(parsed.promptedByUserId).filter((entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      )
      : {};
    return { promptedByUserId };
  } catch {
    return defaultState();
  }
};

const writeState = (state: WebsiteVisibilityPromptState): void => {
  ensureStorageDirs();
  const tempPath = `${WEBSITE_VISIBILITY_PROMPT_STATE_PATH}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(state, null, 2)}\n`);
  renameSync(tempPath, WEBSITE_VISIBILITY_PROMPT_STATE_PATH);
};

export const buildTicketExchangeUrl = (baseUrl: string): string =>
  `${baseUrl.replace(/\/+$/u, "")}/exchange`;

export const buildSpotlightWebsitePromptText = (baseUrl: string): string => `Hey - we've queued your ticket post for extra visibility in the wider Fete chats.

For the best chance of finding someone, you can also list it on Fete Finder Ticket Exchange:
${buildTicketExchangeUrl(baseUrl)}

Listings there can be shared by the bot too, and people unlock contact through the site.`;

export const buildTicketExchangeRedirectText = (
  input: {
    action: "redirect_buying" | "redirect_selling" | "review";
    mentionLabel: string;
    marketplaceName: string;
    baseUrl: string;
  },
): string => {
  const ticketExchangeUrl = buildTicketExchangeUrl(input.baseUrl);

  if (input.action === "redirect_buying") {
    return `Hey ${input.mentionLabel} - looking for tickets? Please post in ${input.marketplaceName}, or use Fete Finder Ticket Exchange:
${ticketExchangeUrl}`;
  }

  if (input.action === "redirect_selling") {
    return `Hey ${input.mentionLabel} - ticket sales belong in ${input.marketplaceName}. For better visibility, you can also list on Fete Finder Ticket Exchange:
${ticketExchangeUrl}`;
  }

  return `Hey ${input.mentionLabel} - this looks ambiguous and is under manual review. If this is a valid ticket post, repost it with clearer details in ${input.marketplaceName}, or use Fete Finder Ticket Exchange:
${ticketExchangeUrl}`;
};

export const shouldSendSpotlightWebsitePrompt = (
  userId: string,
  cooldownDays: number,
  now = new Date(),
): boolean => {
  const promptedAt = readState().promptedByUserId[userId];
  if (!promptedAt) {
    return true;
  }

  const promptedDate = new Date(promptedAt);
  if (!Number.isFinite(promptedDate.getTime())) {
    return true;
  }

  return now.getTime() - promptedDate.getTime() >= Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000;
};

export const recordSpotlightWebsitePromptSent = (userId: string, now = new Date()): void => {
  const state = readState();
  state.promptedByUserId[userId] = now.toISOString();
  writeState(state);
};
