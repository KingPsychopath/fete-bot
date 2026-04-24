import { describe, expect, it } from "vitest";

import { TicketMarketplaceReplyCooldown } from "../replyCooldown.js";

describe("ticket marketplace reply cooldown", () => {
  it("suppresses repeats for the same user in the same group until the ttl expires", () => {
    const cooldown = new TicketMarketplaceReplyCooldown(1_000);

    expect(cooldown.isCoolingDown("group-1", "user-1", 0)).toBe(false);
    cooldown.record("group-1", "user-1", 0);

    expect(cooldown.isCoolingDown("group-1", "user-1", 999)).toBe(true);
    expect(cooldown.isCoolingDown("group-1", "user-1", 1_000)).toBe(false);
  });

  it("keeps different users and groups independent", () => {
    const cooldown = new TicketMarketplaceReplyCooldown(1_000);

    cooldown.record("group-1", "user-1", 0);

    expect(cooldown.isCoolingDown("group-1", "user-2", 500)).toBe(false);
    expect(cooldown.isCoolingDown("group-2", "user-1", 500)).toBe(false);
    expect(cooldown.isCoolingDown("group-1", "user-1", 500)).toBe(true);
  });
});
