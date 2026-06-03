import { describe, expect, it } from "vitest";

import { hasLinkedWhatsAppIdentity, shouldRequestWhatsAppPairingCode } from "./whatsappPairing.js";

describe("WhatsApp pairing", () => {
  it("does not treat a stale Baileys identity as paired when registered is false", () => {
    const creds = {
      registered: false,
      me: {
        id: "447343073599:7@s.whatsapp.net",
        lid: "131272085123192:7@lid",
      },
    };

    expect(hasLinkedWhatsAppIdentity(creds)).toBe(false);
    expect(shouldRequestWhatsAppPairingCode(creds, "447343073599")).toBe(true);
  });

  it("treats a registered auth state as paired", () => {
    expect(hasLinkedWhatsAppIdentity({ registered: true })).toBe(true);
    expect(shouldRequestWhatsAppPairingCode({ registered: true }, "447343073599")).toBe(false);
  });

  it("requests a pairing code for a fresh unlinked auth state", () => {
    expect(shouldRequestWhatsAppPairingCode({ registered: false }, "447343073599")).toBe(true);
  });

  it("does not request a pairing code without a valid phone number", () => {
    expect(shouldRequestWhatsAppPairingCode({ registered: false }, null)).toBe(false);
  });
});
