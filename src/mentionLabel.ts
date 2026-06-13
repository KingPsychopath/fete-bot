const MENTIONABLE_JID_REGEX = /@(s\.whatsapp\.net|lid)$/iu;

const MAX_VISIBLE_NAME_LENGTH = 40;

const cleanPushName = (pushName: string | null): string | null => {
  const cleaned = pushName
    ?.replace(/[\r\n\t]+/gu, " ")
    .replace(/@/gu, "")
    .replace(/\s+/gu, " ")
    .trim();

  if (!cleaned) {
    return null;
  }

  return cleaned.length > MAX_VISIBLE_NAME_LENGTH
    ? `${cleaned.slice(0, MAX_VISIBLE_NAME_LENGTH - 1).trimEnd()}…`
    : cleaned;
};

export const getMentionTargetJid = (senderJid: string, phoneJid?: string | null): string => {
  for (const candidateJid of [senderJid, phoneJid]) {
    if (candidateJid && MENTIONABLE_JID_REGEX.test(candidateJid)) {
      return candidateJid;
    }
  }

  return "";
};

export const getMentionableToken = (senderJid: string, phoneJid?: string | null): string | null => {
  const mentionTargetJid = getMentionTargetJid(senderJid, phoneJid);
  return mentionTargetJid ? (mentionTargetJid.split("@")[0] ?? null) : null;
};

export const formatMentionLabel = (
  senderJid: string,
  pushName: string | null,
  phoneJid?: string | null,
): string => {
  const visibleName = cleanPushName(pushName);
  if (visibleName) {
    return visibleName;
  }

  const mentionToken = getMentionableToken(senderJid, phoneJid);
  return mentionToken ? `@${mentionToken}` : "there";
};
