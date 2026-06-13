import { afterEach, describe, expect, it, vi } from "vitest";

import {
  SafeSendQueue,
  buildRetryDelays,
  clearActiveSafeSendQueue,
  getActiveSafeSendQueueSnapshot,
  installSafeSendGuard,
  setSafeSendWaitForTests,
  skipActiveSafeSendQueueTask,
} from "./safeSend.js";

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
      participantUpdateMinIntervalMs: 2_000,
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
      participantUpdateMinIntervalMs: 0,
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

  it("paces participant updates through the same socket guard", async () => {
    const waits: number[] = [];
    setSafeSendWaitForTests(async (delayMs) => {
      waits.push(delayMs);
    });

    const sendMessage = vi.fn().mockResolvedValue({ key: { id: "sent" } });
    const groupParticipantsUpdate = vi.fn().mockResolvedValue([{ status: "200" }]);
    const sock = {
      sendMessage,
      groupParticipantsUpdate,
    };
    installSafeSendGuard(sock as never, {
      globalMinIntervalMs: 1_000,
      directChatMinIntervalMs: 6_000,
      groupChatMinIntervalMs: 1_500,
      controlMessageMinIntervalMs: 750,
      participantUpdateMinIntervalMs: 2_000,
      maxQueueSize: 10,
      retryDelaysMs: [],
    });

    await sock.sendMessage("group@g.us", { text: "warn" });
    await sock.groupParticipantsUpdate("group@g.us", ["user@s.whatsapp.net"], "remove");

    expect(sendMessage).toHaveBeenCalledTimes(1);
    expect(groupParticipantsUpdate).toHaveBeenCalledTimes(1);
    expect(waits.some((delayMs) => delayMs >= 1_900)).toBe(true);
  });

  it("exposes safe-send queue metadata without message bodies and can skip pending sends", async () => {
    let resolveFirstSend!: (value: { key: { id: string } }) => void;
    const firstSendPromise = new Promise<{ key: { id: string } }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const sendMessage = vi.fn()
      .mockReturnValueOnce(firstSendPromise)
      .mockResolvedValue({ key: { id: "later" } });
    const sock = {
      sendMessage,
      groupParticipantsUpdate: vi.fn(),
    };
    installSafeSendGuard(sock as never, {
      globalMinIntervalMs: 0,
      directChatMinIntervalMs: 0,
      groupChatMinIntervalMs: 0,
      controlMessageMinIntervalMs: 0,
      participantUpdateMinIntervalMs: 0,
      maxQueueSize: 10,
      retryDelaysMs: [],
    });

    const first = sock.sendMessage("one@g.us", { text: "secret one" });
    const second = sock.sendMessage("two@g.us", { text: "secret two" });
    await Promise.resolve();
    await Promise.resolve();

    const snapshot = getActiveSafeSendQueueSnapshot();
    expect(snapshot?.active?.contentKind).toBe("text");
    expect(snapshot?.pending).toHaveLength(1);
    expect(snapshot?.pending[0]?.jid).toBe("two@g.us");
    expect(JSON.stringify(snapshot)).not.toContain("secret");

    expect(skipActiveSafeSendQueueTask(snapshot!.pending[0]!.id)).toBe(true);
    await expect(second).rejects.toThrow("skipped");
    resolveFirstSend({ key: { id: "first" } });
    await expect(first).resolves.toEqual({ key: { id: "first" } });
  });

  it("clears pending safe-send tasks without cancelling the active send", async () => {
    let resolveFirstSend!: (value: { key: { id: string } }) => void;
    const firstSendPromise = new Promise<{ key: { id: string } }>((resolve) => {
      resolveFirstSend = resolve;
    });
    const sendMessage = vi.fn()
      .mockReturnValueOnce(firstSendPromise)
      .mockResolvedValue({ key: { id: "later" } });
    const sock = {
      sendMessage,
      groupParticipantsUpdate: vi.fn(),
    };
    installSafeSendGuard(sock as never, {
      globalMinIntervalMs: 0,
      directChatMinIntervalMs: 0,
      groupChatMinIntervalMs: 0,
      controlMessageMinIntervalMs: 0,
      participantUpdateMinIntervalMs: 0,
      maxQueueSize: 10,
      retryDelaysMs: [],
    });

    const first = sock.sendMessage("one@g.us", { text: "first" });
    const second = sock.sendMessage("two@g.us", { text: "second" });
    const third = sock.sendMessage("three@g.us", { text: "third" });
    await Promise.resolve();
    await Promise.resolve();

    expect(clearActiveSafeSendQueue()).toBe(2);
    await expect(second).rejects.toThrow("cleared");
    await expect(third).rejects.toThrow("cleared");
    resolveFirstSend({ key: { id: "first" } });
    await expect(first).resolves.toEqual({ key: { id: "first" } });
  });
});
