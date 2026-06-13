import { describe, expect, it } from "vitest";

import {
  getDirectCommandReplyTargets,
  getKnownDirectMessageTargets,
  getStartupOwnerAwakeTarget,
  getStartupOwnerAwakeTargets,
} from "./directCommandReply.js";

describe("direct command reply targets", () => {
  it("prefers the inbound LID addressing mode when a direct command arrived from a linked LID", () => {
    expect(getDirectCommandReplyTargets("447700900000@s.whatsapp.net", "111222333@lid")).toEqual([
      "111222333@lid",
      "447700900000@s.whatsapp.net",
    ]);
  });

  it("prefers the inbound phone JID when that is the direct chat", () => {
    expect(getDirectCommandReplyTargets("111222333@lid", "447700900000@s.whatsapp.net")).toEqual([
      "447700900000@s.whatsapp.net",
      "111222333@lid",
    ]);
  });

  it("falls back to the inbound LID when no phone JID is known", () => {
    expect(getDirectCommandReplyTargets("111222333@lid", "111222333@lid")).toEqual(["111222333@lid"]);
  });

  it("preserves group targets for direct commands that intentionally send to a group", () => {
    expect(getDirectCommandReplyTargets("group@g.us", "111222333@lid")).toEqual(["group@g.us"]);
  });
});

describe("known direct message targets", () => {
  it("prefers known LID aliases before phone aliases and the primary JID", () => {
    expect(getKnownDirectMessageTargets("447700900000@s.whatsapp.net", [
      "447700900000@s.whatsapp.net",
      "111222333@lid",
    ])).toEqual(["111222333@lid", "447700900000@s.whatsapp.net"]);
  });

  it("falls back to the primary direct JID when no aliases are known", () => {
    expect(getKnownDirectMessageTargets("447700900000@s.whatsapp.net", [])).toEqual([
      "447700900000@s.whatsapp.net",
    ]);
  });
});

describe("startup owner awake target", () => {
  it("prefers a known owner LID alias over the configured phone JID", () => {
    expect(getStartupOwnerAwakeTarget("447700900000@s.whatsapp.net", [
      "447700900000@s.whatsapp.net",
      "111222333@lid",
    ])).toBe("111222333@lid");
  });

  it("returns every known owner direct identity target in LID-first order", () => {
    expect(getStartupOwnerAwakeTargets("447700900000@s.whatsapp.net", [
      "447700900000@s.whatsapp.net",
      "111222333@lid",
    ])).toEqual(["111222333@lid", "447700900000@s.whatsapp.net"]);
  });

  it("falls back to the configured owner phone JID when no LID alias exists", () => {
    expect(getStartupOwnerAwakeTarget("447700900000@s.whatsapp.net", [])).toBe("447700900000@s.whatsapp.net");
  });
});
