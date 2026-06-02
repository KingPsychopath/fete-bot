const isUserChatJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
const isLidJid = (jid: string): boolean => jid.endsWith("@lid");
const isPhoneJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net");

export const getDirectCommandReplyTargets = (originalJid: string, inboundRemoteJid: string): string[] => {
  return Array.from(new Set([inboundRemoteJid, originalJid].filter(isUserChatJid)));
};

export const getKnownDirectMessageTargets = (
  primaryJid: string,
  knownAliases: readonly string[],
): string[] =>
  Array.from(new Set([
    ...knownAliases.filter(isLidJid),
    ...knownAliases.filter(isPhoneJid),
    primaryJid,
  ].filter(isUserChatJid)));

export const getStartupOwnerAwakeTarget = (ownerJid: string, knownAliases: readonly string[]): string | null => {
  return getStartupOwnerAwakeTargets(ownerJid, knownAliases)[0] ?? null;
};

export const getStartupOwnerAwakeTargets = (ownerJid: string, knownAliases: readonly string[]): string[] => {
  return Array.from(
    new Set([
      ...knownAliases.filter((alias) => alias.endsWith("@lid")),
      ...knownAliases.filter((alias) => alias.endsWith("@s.whatsapp.net")),
      ownerJid,
    ].filter(isUserChatJid)),
  );
};
