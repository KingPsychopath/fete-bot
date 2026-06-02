const isUserChatJid = (jid: string): boolean => jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");

export const getDirectCommandReplyTargets = (originalJid: string, inboundRemoteJid: string): string[] => {
  return Array.from(new Set([inboundRemoteJid, originalJid].filter(isUserChatJid)));
};

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
