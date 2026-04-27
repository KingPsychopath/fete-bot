import type { proto } from "@whiskeysockets/baileys";

import type { AnnouncementGroupMentionConfig } from "../config.js";

export type AnnouncementMentionCandidate = AnnouncementGroupMentionConfig & {
  aliases?: string[];
};

export type AnnouncementMentionAnalysis = {
  resolved: Array<{
    token: string;
    label: string;
    jid: string;
  }>;
  unresolved: string[];
};

const WHATSAPP_FORMATTING_CHARS = /[\u200e\u200f\u202a-\u202e\u2066-\u2069]/gu;

export const buildAnnouncementMentionCandidates = (
  configuredMentions: readonly AnnouncementGroupMentionConfig[],
  knownGroups: ReadonlyMap<string, string> = new Map(),
): AnnouncementMentionCandidate[] => {
  const byJid = new Map<string, { label: string; jid: string; aliases: Set<string> }>();

  const add = (jid: string, label: string, aliases: readonly string[] = []): void => {
    const cleanJid = jid.trim();
    const cleanLabel = label.trim();
    if (!cleanJid.endsWith("@g.us") || !cleanLabel) {
      return;
    }

    const existing = byJid.get(cleanJid) ?? { label: cleanLabel, jid: cleanJid, aliases: new Set<string>() };
    existing.aliases.add(cleanLabel);
    existing.aliases.add(cleanJid);
    for (const alias of aliases) {
      const cleanAlias = alias.trim();
      if (cleanAlias) {
        existing.aliases.add(cleanAlias);
      }
    }
    byJid.set(cleanJid, existing);
  };

  for (const mention of configuredMentions) {
    add(mention.jid, mention.label);
  }

  for (const [jid, subject] of knownGroups.entries()) {
    add(jid, subject);
  }

  return Array.from(byJid.values()).map((candidate) => ({
    label: candidate.label,
    jid: candidate.jid,
    aliases: Array.from(candidate.aliases),
  }));
};

export const buildGroupMentionContext = (
  text: string,
  configuredMentions: readonly AnnouncementMentionCandidate[],
): proto.IContextInfo | undefined => {
  const analysis = analyseAnnouncementMentions(text, configuredMentions);
  const groupMentions = analysis.resolved.map((mention) => ({
    label: mention.label,
    jid: mention.jid,
  }));

  if (groupMentions.length === 0) {
    return undefined;
  }

  return {
    groupMentions: Array.from(new Map(groupMentions.map((mention) => [mention.jid, mention])).values())
      .map((mention) => ({
        groupJid: mention.jid,
        groupSubject: mention.label,
      })),
  };
};

export const analyseAnnouncementMentions = (
  text: string,
  configuredMentions: readonly AnnouncementMentionCandidate[],
): AnnouncementMentionAnalysis => {
  const normalisedText = normaliseMentionText(text);
  const matchedRanges: Array<{ start: number; end: number }> = [];
  const resolvedByJid = new Map<string, { token: string; label: string; jid: string }>();

  const candidates = configuredMentions
    .flatMap((mention) => getMentionAliases(mention).map((alias) => ({ mention, alias })))
    .sort((a, b) => b.alias.length - a.alias.length);

  for (const { mention, alias } of candidates) {
    const cleanAlias = alias.replace(WHATSAPP_FORMATTING_CHARS, "").trim();
    if (!cleanAlias) {
      continue;
    }

    const pattern = new RegExp(`@${escapeRegExp(cleanAlias)}(?=$|[\\s,.;:!?\\)\\]\\}])`, "giu");
    for (const match of normalisedText.matchAll(pattern)) {
      const start = match.index ?? 0;
      const token = match[0] ?? `@${cleanAlias}`;
      const end = start + token.length;
      matchedRanges.push({ start, end });
      resolvedByJid.set(mention.jid, {
        token,
        label: mention.label,
        jid: mention.jid,
      });
    }
  }

  return {
    resolved: Array.from(resolvedByJid.values()),
    unresolved: findUnresolvedMentionTokens(normalisedText, matchedRanges),
  };
};

const normaliseMentionText = (text: string): string => text.replace(WHATSAPP_FORMATTING_CHARS, "");

const getMentionAliases = (mention: AnnouncementMentionCandidate): string[] => [
  mention.label,
  mention.jid,
  ...(mention.aliases ?? []),
];

const hasMentionAlias = (text: string, alias: string): boolean => {
  const cleanAlias = alias.replace(WHATSAPP_FORMATTING_CHARS, "").trim();
  if (!cleanAlias) {
    return false;
  }

  const pattern = new RegExp(`@${escapeRegExp(cleanAlias)}(?=$|[\\s,.;:!?\\)\\]\\}])`, "iu");
  return pattern.test(text);
};

const findUnresolvedMentionTokens = (
  text: string,
  matchedRanges: ReadonlyArray<{ start: number; end: number }>,
): string[] => {
  const unresolved = new Set<string>();
  const mentionPattern = /@[^\s,.;:!?()[\]{}]+(?:\s+(?!@)[^\s,.;:!?()[\]{}]+){0,3}/gu;

  for (const match of text.matchAll(mentionPattern)) {
    const token = (match[0] ?? "").trim();
    const start = match.index ?? 0;
    const end = start + token.length;
    if (!token || matchedRanges.some((range) => start >= range.start && start < range.end)) {
      continue;
    }

    unresolved.add(token.slice(0, 80));
  }

  return Array.from(unresolved);
};

const escapeRegExp = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
