export const ADMIN_MENTION_REPLIES = [
  "Wag 1",
  "Mi deya, what's the problem?",
  "I'm shy, you sort it",
  "POLICE MAN OFFICERRRRR",
  "Who am I punishing",
  "Ah criminal?",
  "I have a name pls",
  "Who called me? Make it quick",
  "Everybody calm down, especially me",
  "Which one of you needs supervision?",
  "I heard my name and felt a disturbance",
  "Proceed, but with receipts",
  "I am not emotionally prepared for this",
  "Before I punish anyone, who brought suya?",
  "Evidence first, drama second",
  "I have arrived. Unfortunately.",
  "Calling admin is not a toy, you know",
  "Somebody say my government name?",
  "Who's claaling me from an unknown number",
  "Please hold while I pretend to be professional",
  "Who do I have to side-eye today?",
] as const;

const ADMIN_MENTION_REGEX = /(^|[^\p{L}\p{N}_])@admin\b/iu;

export const hasAdminMention = (text: string): boolean => ADMIN_MENTION_REGEX.test(text);

export const pickAdminMentionReply = (
  random = Math.random,
  replies: readonly string[] = ADMIN_MENTION_REPLIES,
): string => {
  const index = Math.floor(random() * replies.length);
  return replies[Math.min(index, replies.length - 1)] ?? replies[0] ?? "";
};

export class AdminMentionCooldown {
  private readonly expiresAtByGroupJid = new Map<string, number>();

  constructor(private readonly ttlMs: number) {}

  isCoolingDown(groupJid: string, now: number): boolean {
    const expiresAt = this.expiresAtByGroupJid.get(groupJid);

    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= now) {
      this.expiresAtByGroupJid.delete(groupJid);
      return false;
    }

    return true;
  }

  record(groupJid: string, now: number): void {
    this.expiresAtByGroupJid.set(groupJid, now + this.ttlMs);
    this.prune(now);
  }

  private prune(now: number): void {
    for (const [groupJid, expiresAt] of this.expiresAtByGroupJid) {
      if (expiresAt <= now) {
        this.expiresAtByGroupJid.delete(groupJid);
      }
    }
  }
}
