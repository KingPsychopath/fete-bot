import type {
  AnyMessageContent,
  MiscMessageGenerationOptions,
  WASocket,
} from "@whiskeysockets/baileys";

import { buildDebugParticipantUpdateText, buildDebugRedirectText, getDebugRedirectSwitchState } from "./debugRedirectSwitch.js";
import { warn } from "./logger.js";
import { consumeQuietSwitchSendBypass, isQuietSwitchEnabled } from "./quietSwitch.js";

type SendResult = Awaited<ReturnType<WASocket["sendMessage"]>>;

type QueueTask = {
  jid: string;
  content: AnyMessageContent;
  send: () => Promise<SendResult>;
  resolve: (value: SendResult) => void;
  reject: (reason?: unknown) => void;
  priority: number;
};

export type SafeSendOptions = {
  globalMinIntervalMs: number;
  directChatMinIntervalMs: number;
  groupChatMinIntervalMs: number;
  controlMessageMinIntervalMs: number;
  maxQueueSize: number;
  retryDelaysMs: readonly number[];
};

const DEFAULT_SAFE_SEND_OPTIONS: SafeSendOptions = {
  globalMinIntervalMs: 1_000,
  directChatMinIntervalMs: 6_000,
  groupChatMinIntervalMs: 1_500,
  controlMessageMinIntervalMs: 750,
  maxQueueSize: 1_000,
  retryDelaysMs: [10_000],
};

const normaliseEnvValue = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

const parseNonNegativeInteger = (value: string | undefined, fallback: number): number => {
  const normalisedValue = normaliseEnvValue(value);
  if (!normalisedValue) {
    return fallback;
  }

  const parsed = Number(normalisedValue);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : fallback;
};

const parsePositiveInteger = (value: string | undefined, fallback: number): number => {
  const parsed = parseNonNegativeInteger(value, fallback);
  return parsed > 0 ? parsed : fallback;
};

let wait = (delayMs: number): Promise<void> => new Promise((resolve) => {
  setTimeout(resolve, delayMs);
});

export const setSafeSendWaitForTests = (waitForTests: typeof wait): void => {
  wait = waitForTests;
};

const isDirectChatJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
const isGroupChatJid = (jid: string): boolean => jid.endsWith("@g.us");

const isDeleteMessage = (content: AnyMessageContent): boolean =>
  typeof content === "object" && content !== null && "delete" in content;

const isReactionMessage = (content: AnyMessageContent): boolean =>
  typeof content === "object" && content !== null && "react" in content;

const getTaskPriority = (content: AnyMessageContent): number => {
  if (isDeleteMessage(content)) {
    return 0;
  }

  if (isReactionMessage(content)) {
    return 1;
  }

  return 2;
};

const getTargetMinIntervalMs = (jid: string, content: AnyMessageContent, options: SafeSendOptions): number => {
  if (isDeleteMessage(content) || isReactionMessage(content)) {
    return options.controlMessageMinIntervalMs;
  }

  if (isDirectChatJid(jid)) {
    return options.directChatMinIntervalMs;
  }

  if (isGroupChatJid(jid)) {
    return options.groupChatMinIntervalMs;
  }

  return options.globalMinIntervalMs;
};

const getErrorStatusCode = (value: unknown): number | null => {
  if (typeof value !== "object" || value === null) {
    return null;
  }

  const candidate = value as {
    status?: unknown;
    statusCode?: unknown;
    output?: { statusCode?: unknown };
  };
  const status = candidate.status ?? candidate.statusCode ?? candidate.output?.statusCode;
  return typeof status === "number" ? status : null;
};

const getErrorText = (value: unknown): string =>
  value instanceof Error ? value.message : String(value);

const shouldRetrySendError = (value: unknown): boolean => {
  const statusCode = getErrorStatusCode(value);
  if (statusCode === 429 || statusCode === 408 || (statusCode !== null && statusCode >= 500)) {
    return true;
  }

  return /\b(?:rate|too many|timeout|timed out|connection|socket|unavailable|temporar)/iu.test(getErrorText(value));
};

export class SafeSendQueue {
  private readonly options: SafeSendOptions;
  private readonly queue: QueueTask[] = [];
  private readonly lastSentAtByTarget = new Map<string, number>();
  private running = false;
  private lastGlobalSentAt = 0;

  constructor(options: Partial<SafeSendOptions> = {}) {
    this.options = {
      ...DEFAULT_SAFE_SEND_OPTIONS,
      ...options,
      retryDelaysMs: options.retryDelaysMs ?? DEFAULT_SAFE_SEND_OPTIONS.retryDelaysMs,
    };
  }

  enqueue(
    jid: string,
    content: AnyMessageContent,
    send: () => Promise<SendResult>,
  ): Promise<SendResult> {
    if (this.queue.length >= this.options.maxQueueSize) {
      return Promise.reject(new Error("WhatsApp safe-send queue is full"));
    }

    return new Promise((resolve, reject) => {
      const task: QueueTask = {
        jid,
        content,
        send,
        resolve,
        reject,
        priority: getTaskPriority(content),
      };
      const insertAt = this.queue.findIndex((queuedTask) => queuedTask.priority > task.priority);
      if (insertAt === -1) {
        this.queue.push(task);
      } else {
        this.queue.splice(insertAt, 0, task);
      }
      void this.drain();
    });
  }

  private async drain(): Promise<void> {
    if (this.running) {
      return;
    }

    this.running = true;
    try {
      while (this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task) {
          continue;
        }

        try {
          const result = await this.runTask(task);
          task.resolve(result);
        } catch (sendError) {
          task.reject(sendError);
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async waitForSendSlot(task: QueueTask): Promise<void> {
    const now = Date.now();
    const targetMinIntervalMs = getTargetMinIntervalMs(task.jid, task.content, this.options);
    const lastTargetSentAt = this.lastSentAtByTarget.get(task.jid) ?? 0;
    const globalReadyAt = this.lastGlobalSentAt + this.options.globalMinIntervalMs;
    const targetReadyAt = lastTargetSentAt + targetMinIntervalMs;
    const waitMs = Math.max(0, globalReadyAt - now, targetReadyAt - now);

    if (waitMs > 0) {
      await wait(waitMs);
    }
  }

  private recordAttempt(task: QueueTask): void {
    const now = Date.now();
    this.lastGlobalSentAt = now;
    this.lastSentAtByTarget.set(task.jid, now);
  }

  private async runTask(task: QueueTask): Promise<SendResult> {
    let attempt = 0;
    let lastError: unknown;

    while (attempt <= this.options.retryDelaysMs.length) {
      await this.waitForSendSlot(task);
      try {
        const result = await task.send();
        this.recordAttempt(task);
        return result;
      } catch (sendError) {
        this.recordAttempt(task);
        lastError = sendError;
        const retryDelayMs = this.options.retryDelaysMs[attempt];
        if (retryDelayMs === undefined || !shouldRetrySendError(sendError)) {
          throw sendError;
        }

        warn("WhatsApp send failed; retrying after backoff", {
          jid: task.jid,
          attempt: attempt + 1,
          retryDelayMs,
          error: sendError,
        });
        await wait(retryDelayMs);
      }

      attempt += 1;
    }

    throw lastError;
  }
}

export const buildRetryDelays = (maxAttempts: number, baseDelayMs: number): number[] => {
  const attempts = Math.max(1, maxAttempts);
  const delay = Math.max(0, baseDelayMs);
  return Array.from({ length: attempts - 1 }, (_, index) => delay * 2 ** index);
};

export const getSafeSendOptionsFromEnv = (): SafeSendOptions => {
  const retryMaxAttempts = parsePositiveInteger(process.env.WHATSAPP_SEND_RETRY_MAX_ATTEMPTS, 2);
  const retryBaseDelayMs = parseNonNegativeInteger(process.env.WHATSAPP_SEND_RETRY_BASE_DELAY_MS, 10_000);

  return {
    globalMinIntervalMs: parseNonNegativeInteger(process.env.WHATSAPP_SEND_GLOBAL_MIN_INTERVAL_MS, 1_000),
    groupChatMinIntervalMs: parseNonNegativeInteger(process.env.WHATSAPP_SEND_GROUP_MIN_INTERVAL_MS, 1_500),
    directChatMinIntervalMs: parseNonNegativeInteger(process.env.WHATSAPP_SEND_DIRECT_MIN_INTERVAL_MS, 6_000),
    controlMessageMinIntervalMs: parseNonNegativeInteger(process.env.WHATSAPP_SEND_CONTROL_MIN_INTERVAL_MS, 750),
    maxQueueSize: parsePositiveInteger(process.env.WHATSAPP_SEND_MAX_QUEUE, 1_000),
    retryDelaysMs: buildRetryDelays(retryMaxAttempts, retryBaseDelayMs),
  };
};

export const installSafeSendGuard = (
  sock: WASocket,
  options: Partial<SafeSendOptions> = {},
): void => {
  const queue = new SafeSendQueue(options);
  const originalSendMessage = sock.sendMessage.bind(sock);
  const originalGroupParticipantsUpdate = sock.groupParticipantsUpdate.bind(sock);

  sock.sendMessage = (async (
    jid: string,
    content: AnyMessageContent,
    sendOptions?: MiscMessageGenerationOptions,
  ) => {
    if (isQuietSwitchEnabled() && !consumeQuietSwitchSendBypass(content)) {
      warn("Quiet switch blocked outgoing bot message", {
        jid,
        keys: typeof content === "object" && content !== null ? Object.keys(content) : [],
      });
      return undefined;
    }

    const debugRedirect = getDebugRedirectSwitchState();
    if (debugRedirect.enabled && debugRedirect.targetJid && jid !== debugRedirect.targetJid) {
      const debugJid = debugRedirect.targetJid;
      const redirectText = buildDebugRedirectText(jid, content);
      warn("Debug redirect rerouted outgoing bot message", {
        originalJid: jid,
        debugJid,
        keys: typeof content === "object" && content !== null ? Object.keys(content) : [],
      });
      return queue.enqueue(
        debugJid,
        { text: redirectText },
        () => originalSendMessage(debugJid, {
          text: redirectText,
        }),
      );
    }

    return queue.enqueue(jid, content, () => originalSendMessage(jid, content, sendOptions));
  }) as WASocket["sendMessage"];

  sock.groupParticipantsUpdate = (async (
    jid: string,
    participants: string[],
    action: Parameters<WASocket["groupParticipantsUpdate"]>[2],
  ) => {
    if (isQuietSwitchEnabled()) {
      warn("Quiet switch blocked group participant update", {
        jid,
        participants,
        action,
      });
      return [];
    }

    const debugRedirect = getDebugRedirectSwitchState();
    if (debugRedirect.enabled && debugRedirect.targetJid) {
      const debugJid = debugRedirect.targetJid;
      const redirectText = buildDebugParticipantUpdateText(jid, participants, action);
      warn("Debug redirect blocked group participant update", {
        originalJid: jid,
        debugJid,
        participants,
        action,
      });
      await queue.enqueue(
        debugJid,
        { text: redirectText },
        () => originalSendMessage(debugJid, {
          text: redirectText,
        }),
      );
      return [];
    }

    return originalGroupParticipantsUpdate(jid, participants, action);
  }) as WASocket["groupParticipantsUpdate"];
};
