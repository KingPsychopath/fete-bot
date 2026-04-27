export type SpamReason = "duplicate_message" | "message_flood" | "phone_number";

export type SpamResult =
  | { spam: false }
  | { spam: true; reason: SpamReason; action: "delete" | "warn" };

type SenderMessage = {
  text: string;
  timestamp: number;
};

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const FLOOD_WINDOW_MS = 60 * 1000;
const FLOOD_MESSAGE_LIMIT = 20;
const INACTIVITY_RESET_MS = 60 * 1000;
const PURGE_WINDOW_MS = 10 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

const PHONE_NUMBER_REGEX =
  /(?:\b0\s*7(?:[\s.-]*\d){9}\b|\b44(?:[\s.-]*\d){10}\b|\+\s*44(?:[\s.-]*\d){10}\b|\+\s*\d{2,3}(?:[\s.-]*\d){8,12}\b)/i;

const normaliseMessage = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

const stripUrls = (text: string): string =>
  text.replace(/https?:\/\/\S+/gi, " ").replace(/www\.\S+/gi, " ").replace(/\S+\.\S{2,}\S*/gi, " ");

export class SpamDetector {
  private readonly recentMessages = new Map<string, SenderMessage[]>();

  private readonly messageTimestamps = new Map<string, number[]>();

  private readonly purgeTimer: ReturnType<typeof setInterval>;

  constructor() {
    this.purgeTimer = setInterval(() => {
      this.purgeOldEntries();
    }, PURGE_INTERVAL_MS);

    this.purgeTimer.unref();
  }

  check(senderJid: string, text: string): SpamResult {
    const now = Date.now();
    const normalisedText = normaliseMessage(text);

    this.recordMessage(senderJid, normalisedText, now);
    this.recordTimestamp(senderJid, now);

    if (this.isDuplicateMessage(senderJid, normalisedText, now)) {
      return { spam: true, reason: "duplicate_message", action: "delete" };
    }

    if (this.isFlooding(senderJid, now)) {
      return { spam: true, reason: "message_flood", action: "delete" };
    }

    if (this.containsPhoneNumber(text)) {
      return { spam: true, reason: "phone_number", action: "warn" };
    }

    return { spam: false };
  }

  private recordMessage(senderJid: string, text: string, timestamp: number): void {
    const messages = (this.recentMessages.get(senderJid) ?? []).filter(
      (message) => timestamp - message.timestamp <= DUPLICATE_WINDOW_MS,
    );

    messages.push({ text, timestamp });
    this.recentMessages.set(senderJid, messages.slice(-3));
  }

  private recordTimestamp(senderJid: string, timestamp: number): void {
    const timestamps = this.messageTimestamps.get(senderJid) ?? [];
    const lastTimestamp = timestamps.at(-1);
    const withinActiveWindow =
      typeof lastTimestamp === "number" ? timestamp - lastTimestamp <= INACTIVITY_RESET_MS : true;
    const nextTimestamps = withinActiveWindow ? timestamps : [];

    nextTimestamps.push(timestamp);
    this.messageTimestamps.set(
      senderJid,
      nextTimestamps.filter((value) => timestamp - value <= FLOOD_WINDOW_MS),
    );
  }

  private isDuplicateMessage(senderJid: string, text: string, timestamp: number): boolean {
    const messages = (this.recentMessages.get(senderJid) ?? []).filter(
      (message) => timestamp - message.timestamp <= DUPLICATE_WINDOW_MS,
    );

    return messages.filter((message) => message.text === text).length >= 3;
  }

  private isFlooding(senderJid: string, timestamp: number): boolean {
    const timestamps = (this.messageTimestamps.get(senderJid) ?? []).filter(
      (value) => timestamp - value <= FLOOD_WINDOW_MS,
    );

    this.messageTimestamps.set(senderJid, timestamps);
    return timestamps.length >= FLOOD_MESSAGE_LIMIT;
  }

  private containsPhoneNumber(text: string): boolean {
    const withoutUrls = stripUrls(text);
    return PHONE_NUMBER_REGEX.test(withoutUrls);
  }

  private purgeOldEntries(): void {
    const now = Date.now();

    for (const [senderJid, messages] of this.recentMessages.entries()) {
      const filtered = messages.filter((message) => now - message.timestamp <= PURGE_WINDOW_MS);
      if (filtered.length > 0) {
        this.recentMessages.set(senderJid, filtered);
      } else {
        this.recentMessages.delete(senderJid);
      }
    }

    for (const [senderJid, timestamps] of this.messageTimestamps.entries()) {
      const filtered = timestamps.filter((timestamp) => now - timestamp <= PURGE_WINDOW_MS);
      if (filtered.length > 0) {
        this.messageTimestamps.set(senderJid, filtered);
      } else {
        this.messageTimestamps.delete(senderJid);
      }
    }
  }
}
