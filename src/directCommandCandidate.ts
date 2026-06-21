export const isAnnouncementConfirmationText = (text: string): boolean =>
  /^confirm\s+[a-z0-9]+$/iu.test(text.trim());

export const isDirectCommandCandidateText = (text: string): boolean =>
  text.trim().startsWith("!") || isAnnouncementConfirmationText(text);
