export const DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MS = 30 * 60 * 1000;
const DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MAX_ENTRIES = 2_000;

export class TicketMarketplaceReplyCooldown {
  private readonly expiresAtByKey = new Map<string, number>();

  constructor(
    private readonly ttlMs = DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MS,
    private readonly maxEntries = DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MAX_ENTRIES,
  ) {}

  isCoolingDown(groupJid: string, userId: string, now: number): boolean {
    this.prune(now);

    const key = this.getKey(groupJid, userId);
    const expiresAt = this.expiresAtByKey.get(key);

    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= now) {
      this.expiresAtByKey.delete(key);
      return false;
    }

    return true;
  }

  record(groupJid: string, userId: string, now: number): void {
    this.expiresAtByKey.set(this.getKey(groupJid, userId), now + this.ttlMs);
    this.prune(now);
  }

  private getKey(groupJid: string, userId: string): string {
    return `${groupJid}:${userId}`;
  }

  private prune(now: number): void {
    for (const [key, expiresAt] of this.expiresAtByKey) {
      if (expiresAt <= now) {
        this.expiresAtByKey.delete(key);
      }
    }

    const overflow = this.expiresAtByKey.size - this.maxEntries;
    if (overflow <= 0) {
      return;
    }

    let deleted = 0;
    for (const key of this.expiresAtByKey.keys()) {
      this.expiresAtByKey.delete(key);
      deleted += 1;

      if (deleted >= overflow) {
        return;
      }
    }
  }
}
