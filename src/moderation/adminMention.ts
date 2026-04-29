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
  "Who's calling me from an unknown number",
  "Please hold while I pretend to be professional",
  "Who do I have to side-eye today?",
  "Before you run to conclusions, did you run to the gym today?",
] as const;

export const ADMIN_MENTION_OVERUSE_REPLIES = [
  "Leave me alone. You're so obsessed with me",
  "Leave me alone. Please go touch grass.",
  "Leave me alone. I'm shy.",
  "Leave me alone. You are overstimulating me",
] as const;

const ADMIN_MENTION_REGEX = /(^|[^\p{L}\p{N}_])@admins?\b/iu;

export const hasAdminMention = (text: string): boolean => ADMIN_MENTION_REGEX.test(text);

const normalizeMentionJid = (jid: string): string => {
  const trimmed = jid.trim().toLowerCase();
  const atIndex = trimmed.lastIndexOf("@");

  if (atIndex < 0) {
    return trimmed;
  }

  const user = trimmed.slice(0, atIndex);
  const server = trimmed.slice(atIndex + 1);
  const normalizedUser = server === "s.whatsapp.net" || server === "lid"
    ? user.split(":")[0] ?? user
    : user;

  return `${normalizedUser}@${server}`;
};

export const hasBotSelfMention = (
  mentionedJids: readonly string[],
  selfJids: ReadonlySet<string>,
): boolean => mentionedJids.some((jid) => selfJids.has(normalizeMentionJid(jid)));

export const hasAdminSummon = (
  text: string,
  mentionedJids: readonly string[],
  selfJids: ReadonlySet<string>,
): boolean => hasAdminMention(text) || hasBotSelfMention(mentionedJids, selfJids);

export const pickAdminMentionReply = (
  random = Math.random,
  replies: readonly string[] = ADMIN_MENTION_REPLIES,
): string => {
  const index = Math.floor(random() * replies.length);
  return replies[Math.min(index, replies.length - 1)] ?? replies[0] ?? "";
};

export class AdminMentionCooldown {
  private readonly expiresAtByGroupJid = new Map<string, number>();
  private readonly mentionTimesByGroupJid = new Map<string, number[]>();
  private readonly overuseReplyExpiresAtByGroupJid = new Map<string, number>();

  constructor(
    private readonly ttlMs: number,
    private readonly overuseWindowMs = ttlMs,
    private readonly overuseThreshold = 3,
  ) {}

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

  recordSummon(groupJid: string, now: number): boolean {
    const mentionTimes = this.recordMention(groupJid, now);

    if (mentionTimes.length < this.overuseThreshold) {
      return false;
    }

    if (this.isOveruseReplyCoolingDown(groupJid, now)) {
      return false;
    }

    this.overuseReplyExpiresAtByGroupJid.set(groupJid, now + this.ttlMs);
    return true;
  }

  recordCooldown(groupJid: string, now: number): void {
    this.expiresAtByGroupJid.set(groupJid, now + this.ttlMs);
    this.prune(now);
  }

  private recordMention(groupJid: string, now: number): number[] {
    const windowStart = now - this.overuseWindowMs;
    const mentionTimes = (this.mentionTimesByGroupJid.get(groupJid) ?? [])
      .filter((mentionTime) => mentionTime > windowStart);

    mentionTimes.push(now);
    this.mentionTimesByGroupJid.set(groupJid, mentionTimes);
    this.prune(now);

    return mentionTimes;
  }

  private isOveruseReplyCoolingDown(groupJid: string, now: number): boolean {
    const expiresAt = this.overuseReplyExpiresAtByGroupJid.get(groupJid);

    if (!expiresAt) {
      return false;
    }

    if (expiresAt <= now) {
      this.overuseReplyExpiresAtByGroupJid.delete(groupJid);
      return false;
    }

    return true;
  }

  private prune(now: number): void {
    for (const [groupJid, expiresAt] of this.expiresAtByGroupJid) {
      if (expiresAt <= now) {
        this.expiresAtByGroupJid.delete(groupJid);
      }
    }

    for (const [groupJid, mentionTimes] of this.mentionTimesByGroupJid) {
      const activeMentionTimes = mentionTimes.filter((mentionTime) => mentionTime > now - this.overuseWindowMs);

      if (activeMentionTimes.length === 0) {
        this.mentionTimesByGroupJid.delete(groupJid);
      } else {
        this.mentionTimesByGroupJid.set(groupJid, activeMentionTimes);
      }
    }

    for (const [groupJid, expiresAt] of this.overuseReplyExpiresAtByGroupJid) {
      if (expiresAt <= now) {
        this.overuseReplyExpiresAtByGroupJid.delete(groupJid);
      }
    }
  }
}
