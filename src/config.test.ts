import { afterEach, describe, expect, it, vi } from "vitest";

const managedEnvKeys = [
  "DOTENV_CONFIG_PATH",
  "TICKET_EXCHANGE_WEBSITE_ANNOUNCEMENTS_ENABLED",
  "TICKET_EXCHANGE_WEBSITE_TARGET_JIDS",
  "NON_ADMIN_AUTOMATIC_DMS_ENABLED",
  "TICKET_MARKETPLACE_GROUP_JIDS",
  "TICKET_SPOTLIGHT_ENABLED",
] as const;

const originalEnv = { ...process.env };

const resetManagedEnv = (): void => {
  for (const key of managedEnvKeys) {
    delete process.env[key];
  }
};

const loadConfig = async (env: Partial<Record<(typeof managedEnvKeys)[number], string>> = {}) => {
  vi.resetModules();
  resetManagedEnv();
  process.env.DOTENV_CONFIG_PATH = "/tmp/fete-bot-config-test-missing.env";
  Object.assign(process.env, env);
  return (await import("./config.js")).config;
};

afterEach(() => {
  vi.resetModules();
  for (const key of Object.keys(process.env)) {
    delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe("config ticket exchange defaults", () => {
  it("enables website exchange announcements to the FDLM marketplace by default while spotlight stays off", async () => {
    const config = await loadConfig();

    expect(config.ticketMarketplaceGroupJids).toEqual(["120363418331899807@g.us"]);
    expect(config.ticketExchangeWebsiteAnnouncementsEnabled).toBe(true);
    expect(config.nonAdminAutomaticDmsEnabled).toBe(true);
    expect(config.ticketExchangeWebsiteTargetJids).toEqual(["120363418331899807@g.us"]);
    expect(config.ticketSpotlightEnabled).toBe(false);
  });

  it("can disable automatic DMs to non-admin users", async () => {
    const config = await loadConfig({
      NON_ADMIN_AUTOMATIC_DMS_ENABLED: "false",
    });

    expect(config.nonAdminAutomaticDmsEnabled).toBe(false);
  });

  it("uses configured marketplace groups as the website exchange announcement target fallback", async () => {
    const config = await loadConfig({
      TICKET_MARKETPLACE_GROUP_JIDS: "market-1@g.us,market-2@g.us",
    });

    expect(config.ticketMarketplaceGroupJids).toEqual(["market-1@g.us", "market-2@g.us"]);
    expect(config.ticketExchangeWebsiteTargetJids).toEqual(["market-1@g.us", "market-2@g.us"]);
  });

  it("keeps an explicit website exchange target override", async () => {
    const config = await loadConfig({
      TICKET_EXCHANGE_WEBSITE_TARGET_JIDS: "override@g.us",
      TICKET_MARKETPLACE_GROUP_JIDS: "market@g.us",
    });

    expect(config.ticketExchangeWebsiteTargetJids).toEqual(["override@g.us"]);
  });
});
