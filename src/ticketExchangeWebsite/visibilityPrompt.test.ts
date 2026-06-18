import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildTicketExchangeListingGroupPromptText,
  buildTicketExchangeListingPromptText,
  buildTicketExchangeRedirectText,
  buildTicketExchangeUrl,
  planTicketExchangeListingPromptDelivery,
} from "./visibilityPrompt.js";

let tempDir: string;
let previousRailwayVolumeMountPath: string | undefined;

beforeEach(() => {
  tempDir = mkdtempSync(path.join(os.tmpdir(), "fete-bot-visibility-prompt-"));
  previousRailwayVolumeMountPath = process.env.RAILWAY_VOLUME_MOUNT_PATH;
  process.env.RAILWAY_VOLUME_MOUNT_PATH = tempDir;
});

afterEach(() => {
  if (previousRailwayVolumeMountPath === undefined) {
    delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
  } else {
    process.env.RAILWAY_VOLUME_MOUNT_PATH = previousRailwayVolumeMountPath;
  }
  rmSync(tempDir, { recursive: true, force: true });
  vi.resetModules();
});

describe("Ticket Exchange visibility prompts", () => {
  it("builds the public Ticket Exchange URL", () => {
    expect(buildTicketExchangeUrl("https://fete.outofofficecollective.co.uk/")).toBe(
      "https://fete.outofofficecollective.co.uk/exchange",
    );
  });

  it("builds the Ticket Exchange listing DM prompt", () => {
    const text = buildTicketExchangeListingPromptText("https://fete.outofofficecollective.co.uk");

    expect(text).not.toContain("queued");
    expect(text).toContain("You can also add your ticket post here");
    expect(text).toContain("contact stays behind the site");
    expect(text).toContain("https://fete.outofofficecollective.co.uk/exchange");
  });

  it("builds the Ticket Exchange listing group prompt with a mention", () => {
    const text = buildTicketExchangeListingGroupPromptText("@447700900000", "https://fete.outofofficecollective.co.uk");

    expect(text).toContain("@447700900000 you can also add your ticket post here");
    expect(text).not.toContain("queued");
    expect(text).toContain("https://fete.outofofficecollective.co.uk/exchange");
  });

  it("builds buying and selling redirect copy", () => {
    expect(
      buildTicketExchangeRedirectText({
        action: "redirect_buying",
        mentionLabel: "@447700900000",
        marketplaceName: "FDLM Ticket Marketplace",
        baseUrl: "https://fete.outofofficecollective.co.uk",
      }),
    ).toContain("ticket requests go in FDLM Ticket Marketplace. You can also use");

    expect(
      buildTicketExchangeRedirectText({
        action: "redirect_selling",
        mentionLabel: "@447700900000",
        marketplaceName: "FDLM Ticket Marketplace",
        baseUrl: "https://fete.outofofficecollective.co.uk",
      }),
    ).toContain("ticket sales go in FDLM Ticket Marketplace. You can also list here");
  });

  it("keeps the group listing prompt on when non-admin automatic DMs are off", () => {
    expect(
      planTicketExchangeListingPromptDelivery({
        userPromptAllowed: true,
        groupPromptAllowed: true,
        automaticDmAllowed: false,
      }),
    ).toEqual({
      sendDirectPrompt: false,
      sendGroupPrompt: true,
      directPromptSkippedByDmGate: true,
      userPromptCoolingDown: false,
      groupPromptCoolingDown: false,
    });
  });

  it("keeps group cooldown independent from DM delivery", () => {
    expect(
      planTicketExchangeListingPromptDelivery({
        userPromptAllowed: true,
        groupPromptAllowed: false,
        automaticDmAllowed: true,
      }),
    ).toMatchObject({
      sendDirectPrompt: true,
      sendGroupPrompt: false,
      directPromptSkippedByDmGate: false,
      groupPromptCoolingDown: true,
    });
  });

  it("persists spotlight DM prompt cooldowns by user", async () => {
    vi.resetModules();
    const {
      recordSpotlightWebsiteGroupPromptSent,
      recordSpotlightWebsitePromptSent,
      shouldSendSpotlightWebsiteGroupPrompt,
      shouldSendSpotlightWebsitePrompt,
    } = await import("./visibilityPrompt.js");

    const sentAt = new Date("2026-06-02T10:00:00.000Z");

    expect(shouldSendSpotlightWebsitePrompt("user-1", 7, sentAt)).toBe(true);
    recordSpotlightWebsitePromptSent("user-1", sentAt);
    expect(shouldSendSpotlightWebsitePrompt("user-1", 7, new Date("2026-06-09T09:59:59.999Z"))).toBe(false);
    expect(shouldSendSpotlightWebsitePrompt("user-1", 7, new Date("2026-06-09T10:00:00.000Z"))).toBe(true);
    expect(shouldSendSpotlightWebsitePrompt("user-2", 7, sentAt)).toBe(true);

    expect(shouldSendSpotlightWebsiteGroupPrompt("group-1@g.us", 6, sentAt)).toBe(true);
    recordSpotlightWebsiteGroupPromptSent("group-1@g.us", sentAt);
    expect(shouldSendSpotlightWebsiteGroupPrompt("group-1@g.us", 6, new Date("2026-06-02T15:59:59.999Z"))).toBe(false);
    expect(shouldSendSpotlightWebsiteGroupPrompt("group-1@g.us", 6, new Date("2026-06-02T16:00:00.000Z"))).toBe(true);
    expect(shouldSendSpotlightWebsiteGroupPrompt("group-2@g.us", 6, sentAt)).toBe(true);
  });
});
