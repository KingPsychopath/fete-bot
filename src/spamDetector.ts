export type SpamReason = "duplicate_message" | "message_flood" | "phone_number";

export type SpamResult =
  | { spam: false }
  | { spam: true; reason: SpamReason; action: "delete" | "warn" };

type SenderMessage = {
  text: string;
  timestamp: number;
};

export type SpamDetectorOptions = {
  duplicateMinLength?: number;
  floodWarnMessageLimit?: number;
  floodDeleteMessageLimit?: number;
};

const DUPLICATE_WINDOW_MS = 5 * 60 * 1000;
const FLOOD_WINDOW_MS = 60 * 1000;
const DEFAULT_DUPLICATE_MIN_LENGTH = 20;
const DEFAULT_FLOOD_WARN_MESSAGE_LIMIT = 20;
const DEFAULT_FLOOD_DELETE_MESSAGE_LIMIT = 25;
const INACTIVITY_RESET_MS = 60 * 1000;
const PURGE_WINDOW_MS = 10 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

const PHONE_NUMBER_REGEX =
  /(?:\b0\s*7(?:[\s.-]*\d){9}\b|\b44(?:[\s.-]*\d){10}\b|\+\s*44(?:[\s.-]*\d){10}\b|\+\s*\d{2,3}(?:[\s.-]*\d){8,12}\b)/i;

const normaliseMessage = (text: string): string => text.trim().replace(/\s+/g, " ").toLowerCase();

const stripUrls = (text: string): string =>
  text.replace(/https?:\/\/\S+/gi, " ").replace(/www\.\S+/gi, " ").replace(/\S+\.\S{2,}\S*/gi, " ");

const getSenderGroupKey = (senderJid: string, groupJid: string): string => `${groupJid}:${senderJid}`;

export class SpamDetector {
  private readonly recentMessages = new Map<string, SenderMessage[]>();

  private readonly messageTimestamps = new Map<string, number[]>();

  private readonly floodWarnedKeys = new Set<string>();

  private readonly duplicateMinLength: number;

  private readonly floodWarnMessageLimit: number;

  private readonly floodDeleteMessageLimit: number;

  private readonly purgeTimer: ReturnType<typeof setInterval>;

  constructor(options: SpamDetectorOptions = {}) {
    this.duplicateMinLength = options.duplicateMinLength ?? DEFAULT_DUPLICATE_MIN_LENGTH;
    this.floodWarnMessageLimit = options.floodWarnMessageLimit ?? DEFAULT_FLOOD_WARN_MESSAGE_LIMIT;
    this.floodDeleteMessageLimit = Math.max(
      options.floodDeleteMessageLimit ?? DEFAULT_FLOOD_DELETE_MESSAGE_LIMIT,
      this.floodWarnMessageLimit + 1,
    );

    this.purgeTimer = setInterval(() => {
      this.purgeOldEntries();
    }, PURGE_INTERVAL_MS);

    this.purgeTimer.unref();
  }

  check(senderJid: string, groupJid: string, text: string): SpamResult {
    const now = Date.now();
    const senderGroupKey = getSenderGroupKey(senderJid, groupJid);
    const normalisedText = normaliseMessage(text);

    this.recordMessage(senderGroupKey, normalisedText, now);
    this.recordTimestamp(senderGroupKey, now);

    if (this.isDuplicateMessage(senderGroupKey, normalisedText, now)) {
      return { spam: true, reason: "duplicate_message", action: "delete" };
    }

    const floodResult = this.checkFlooding(senderGroupKey, now);
    if (floodResult) {
      return floodResult;
    }

    if (this.containsPhoneNumber(text)) {
      return { spam: true, reason: "phone_number", action: "warn" };
    }

    return { spam: false };
  }

  private recordMessage(senderGroupKey: string, text: string, timestamp: number): void {
    const messages = (this.recentMessages.get(senderGroupKey) ?? []).filter(
      (message) => timestamp - message.timestamp <= DUPLICATE_WINDOW_MS,
    );

    messages.push({ text, timestamp });
    this.recentMessages.set(senderGroupKey, messages.slice(-3));
  }

  private recordTimestamp(senderGroupKey: string, timestamp: number): void {
    const timestamps = this.messageTimestamps.get(senderGroupKey) ?? [];
    const lastTimestamp = timestamps.at(-1);
    const withinActiveWindow =
      typeof lastTimestamp === "number" ? timestamp - lastTimestamp <= INACTIVITY_RESET_MS : true;
    const nextTimestamps = withinActiveWindow ? timestamps : [];

    if (!withinActiveWindow) {
      this.floodWarnedKeys.delete(senderGroupKey);
    }

    nextTimestamps.push(timestamp);
    this.messageTimestamps.set(
      senderGroupKey,
      nextTimestamps.filter((value) => timestamp - value <= FLOOD_WINDOW_MS),
    );
  }

  private isDuplicateMessage(senderGroupKey: string, text: string, timestamp: number): boolean {
    if (text.length < this.duplicateMinLength) {
      return false;
    }

    const messages = (this.recentMessages.get(senderGroupKey) ?? []).filter(
      (message) => timestamp - message.timestamp <= DUPLICATE_WINDOW_MS,
    );

    return messages.filter((message) => message.text === text).length >= 3;
  }

  private checkFlooding(senderGroupKey: string, timestamp: number): SpamResult | null {
    const timestamps = (this.messageTimestamps.get(senderGroupKey) ?? []).filter(
      (value) => timestamp - value <= FLOOD_WINDOW_MS,
    );

    this.messageTimestamps.set(senderGroupKey, timestamps);

    if (timestamps.length >= this.floodDeleteMessageLimit) {
      return { spam: true, reason: "message_flood", action: "delete" };
    }

    if (timestamps.length >= this.floodWarnMessageLimit && !this.floodWarnedKeys.has(senderGroupKey)) {
      this.floodWarnedKeys.add(senderGroupKey);
      return { spam: true, reason: "message_flood", action: "warn" };
    }

    return null;
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
        this.floodWarnedKeys.delete(senderJid);
      }
    }
  }
}
