import { afterEach, describe, expect, it, vi } from "vitest";

import { SafeSendQueue, buildRetryDelays, setSafeSendWaitForTests } from "./safeSend.js";

describe("SafeSendQueue", () => {
  afterEach(() => {
    setSafeSendWaitForTests((delayMs) => new Promise((resolve) => {
      setTimeout(resolve, delayMs);
    }));
    vi.restoreAllMocks();
  });

  it("paces repeated direct sends to the same target", async () => {
    const waits: number[] = [];
    setSafeSendWaitForTests(async (delayMs) => {
      waits.push(delayMs);
    });

    const queue = new SafeSendQueue({
      globalMinIntervalMs: 1_000,
      directChatMinIntervalMs: 6_000,
      groupChatMinIntervalMs: 1_500,
      controlMessageMinIntervalMs: 750,
      maxQueueSize: 10,
      retryDelaysMs: [],
    });
    const send = vi.fn().mockResolvedValue({ key: { id: "sent" } });

    await queue.enqueue("447700900000@s.whatsapp.net", { text: "one" }, send);
    await queue.enqueue("447700900000@s.whatsapp.net", { text: "two" }, send);

    expect(send).toHaveBeenCalledTimes(2);
    expect(waits.some((delayMs) => delayMs >= 5_900)).toBe(true);
  });

  it("retries transient send failures with backoff", async () => {
    const waits: number[] = [];
    setSafeSendWaitForTests(async (delayMs) => {
      waits.push(delayMs);
    });

    const queue = new SafeSendQueue({
      globalMinIntervalMs: 0,
      directChatMinIntervalMs: 0,
      groupChatMinIntervalMs: 0,
      controlMessageMinIntervalMs: 0,
      maxQueueSize: 10,
      retryDelaysMs: [250],
    });
    const transientError = Object.assign(new Error("rate limit hit"), { status: 429 });
    const send = vi
      .fn()
      .mockRejectedValueOnce(transientError)
      .mockResolvedValueOnce({ key: { id: "sent-after-retry" } });

    await expect(queue.enqueue("group@g.us", { text: "hello" }, send)).resolves.toEqual({
      key: { id: "sent-after-retry" },
    });
    expect(send).toHaveBeenCalledTimes(2);
    expect(waits).toContain(250);
  });

  it("builds exponential retry delays from max attempts", () => {
    expect(buildRetryDelays(1, 1_000)).toEqual([]);
    expect(buildRetryDelays(4, 1_000)).toEqual([1_000, 2_000, 4_000]);
  });
});
