import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  buildSpotlightWebsiteGroupPromptText,
  buildSpotlightWebsitePromptText,
  buildTicketExchangeRedirectText,
  buildTicketExchangeUrl,
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

  it("builds the spotlight DM prompt", () => {
    const text = buildSpotlightWebsitePromptText("https://fete.outofofficecollective.co.uk");

    expect(text).toContain("we've queued your ticket post for extra visibility");
    expect(text).toContain("Fete Finder Ticket Exchange");
    expect(text).toContain("https://fete.outofofficecollective.co.uk/exchange");
  });

  it("builds the spotlight group prompt with a mention", () => {
    const text = buildSpotlightWebsiteGroupPromptText("@447700900000", "https://fete.outofofficecollective.co.uk");

    expect(text).toContain("Hey @447700900000");
    expect(text).toContain("your ticket post has been queued for extra visibility");
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
    ).toContain("Please post in FDLM Ticket Marketplace, or use Fete Finder Ticket Exchange");

    expect(
      buildTicketExchangeRedirectText({
        action: "redirect_selling",
        mentionLabel: "@447700900000",
        marketplaceName: "FDLM Ticket Marketplace",
        baseUrl: "https://fete.outofofficecollective.co.uk",
      }),
    ).toContain("For better visibility, you can also list on Fete Finder Ticket Exchange");
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
