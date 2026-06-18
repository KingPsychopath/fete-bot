import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { DATA_DIR, ensureStorageDirs } from "../storagePaths.js";

const WEBSITE_VISIBILITY_PROMPT_STATE_PATH = join(DATA_DIR, "ticket-exchange-visibility-prompts.json");

type WebsiteVisibilityPromptState = {
  promptedByUserId: Record<string, string>;
  promptedByGroupJid: Record<string, string>;
};

export type TicketExchangeListingPromptDeliveryInput = {
  userPromptAllowed: boolean;
  groupPromptAllowed: boolean;
  automaticDmAllowed: boolean;
};

export type TicketExchangeListingPromptDeliveryPlan = {
  sendDirectPrompt: boolean;
  sendGroupPrompt: boolean;
  directPromptSkippedByDmGate: boolean;
  userPromptCoolingDown: boolean;
  groupPromptCoolingDown: boolean;
};

const defaultState = (): WebsiteVisibilityPromptState => ({ promptedByUserId: {}, promptedByGroupJid: {} });

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
    const promptedByGroupJid = parsed.promptedByGroupJid && typeof parsed.promptedByGroupJid === "object"
      ? Object.fromEntries(
        Object.entries(parsed.promptedByGroupJid).filter((entry): entry is [string, string] =>
          typeof entry[0] === "string" && typeof entry[1] === "string",
        ),
      )
      : {};
    return { promptedByUserId, promptedByGroupJid };
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

export const buildTicketExchangeListingPromptText = (baseUrl: string): string => `You can also add your ticket post here:
${buildTicketExchangeUrl(baseUrl)}

Listings there can be shared into the chat, and contact stays behind the site.`;

export const buildTicketExchangeListingGroupPromptText = (mentionLabel: string, baseUrl: string): string =>
  `${mentionLabel} you can also add your ticket post here:
${buildTicketExchangeUrl(baseUrl)}`;

export const buildSpotlightWebsitePromptText = buildTicketExchangeListingPromptText;

export const buildSpotlightWebsiteGroupPromptText = buildTicketExchangeListingGroupPromptText;

export const planTicketExchangeListingPromptDelivery = (
  input: TicketExchangeListingPromptDeliveryInput,
): TicketExchangeListingPromptDeliveryPlan => ({
  sendDirectPrompt: input.userPromptAllowed && input.automaticDmAllowed,
  sendGroupPrompt: input.groupPromptAllowed,
  directPromptSkippedByDmGate: input.userPromptAllowed && !input.automaticDmAllowed,
  userPromptCoolingDown: !input.userPromptAllowed,
  groupPromptCoolingDown: !input.groupPromptAllowed,
});

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
    return `${input.mentionLabel} ticket requests go in ${input.marketplaceName}. You can also use:
${ticketExchangeUrl}`;
  }

  if (input.action === "redirect_selling") {
    return `${input.mentionLabel} ticket sales go in ${input.marketplaceName}. You can also list here:
${ticketExchangeUrl}`;
  }

  return `${input.mentionLabel} this ticket post needs clearer details and is under review. You can repost in ${input.marketplaceName}, or use:
${ticketExchangeUrl}`;
};

export const shouldSendSpotlightWebsitePrompt = (
  userId: string,
  cooldownDays: number,
  now = new Date(),
): boolean => {
  const promptedAt = readState().promptedByUserId[userId];
  return isPastCooldownMs(promptedAt, Math.max(0, cooldownDays) * 24 * 60 * 60 * 1000, now);
};

const isPastCooldownMs = (
  promptedAt: string | undefined,
  cooldownMs: number,
  now: Date,
): boolean => {
  if (!promptedAt) {
    return true;
  }

  const promptedDate = new Date(promptedAt);
  if (!Number.isFinite(promptedDate.getTime())) {
    return true;
  }

  return now.getTime() - promptedDate.getTime() >= cooldownMs;
};

export const shouldSendSpotlightWebsiteGroupPrompt = (
  groupJid: string,
  cooldownHours: number,
  now = new Date(),
): boolean => isPastCooldownMs(
  readState().promptedByGroupJid[groupJid],
  Math.max(0, cooldownHours) * 60 * 60 * 1000,
  now,
);

export const recordSpotlightWebsitePromptSent = (userId: string, now = new Date()): void => {
  const state = readState();
  state.promptedByUserId[userId] = now.toISOString();
  writeState(state);
};

export const recordSpotlightWebsiteGroupPromptSent = (groupJid: string, now = new Date()): void => {
  const state = readState();
  state.promptedByGroupJid[groupJid] = now.toISOString();
  writeState(state);
};
