export const DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MS = 30 * 60 * 1000;

export class TicketMarketplaceReplyCooldown {
  private readonly expiresAtByKey = new Map<string, number>();

  constructor(private readonly ttlMs = DEFAULT_TICKET_MARKETPLACE_REPLY_COOLDOWN_MS) {}

  isCoolingDown(groupJid: string, userId: string, now: number): boolean {
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
  }
}
