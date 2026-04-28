export type GroupInviteLinkClassification = {
  matched: boolean;
  reason: string | null;
  matchedSignal: string | null;
};

const normaliseText = (text: string): string =>
  text
    .normalize("NFKC")
    .replace(/[’‘`´]/gu, "'")
    .replace(/[?!.,;:()[\]{}"“”]+/gu, " ")
    .replace(/[^\p{L}\p{N}']+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .toLowerCase();

const HIGH_PRECISION_PATTERNS: Array<{ label: string; regex: RegExp }> = [
  {
    label: "chat/group link",
    regex: /\b(?:chat|group|whatsapp|watsapp|wa|channel|community)\s+(?:invite\s+)?link\b/iu,
  },
  {
    label: "link for chat/group",
    regex: /\blink\s+(?:for|to|2)\s+(?:(?:the|this|that|our|current)\s+){0,2}(?:chat|group|whatsapp|watsapp|wa|channel|community)\b/iu,
  },
  {
    label: "join link",
    regex: /\b(?:join|joining)\s+link\b/iu,
  },
  {
    label: "invite link",
    regex: /\binvite\s+link\b/iu,
  },
  {
    label: "group invite",
    regex: /\b(?:group|chat|whatsapp|watsapp|wa|channel|community)\s+invite\b/iu,
  },
  {
    label: "link to send someone to join group",
    regex:
      /\blink\b(?=.{0,80}\b(?:send|share|forward|give|pass)\b)(?=.{0,120}\b(?:someone|somebody|some1|whoever|a\s+friend|my\s+friend|friends|my\s+friends|a\s+mate|my\s+mate|mates|my\s+mates|people|person|them|him|her)\b)(?=.{0,120}\b(?:join|get\s+into|get\s+in|be\s+added|add(?:ed)?)\b)(?=.{0,140}\b(?:(?:the|this|that|our|current)\s+){0,2}(?:group|chat|whatsapp|watsapp|wa|channel|community)\b)/iu,
  },
  {
    label: "shareable link for someone to join group",
    regex:
      /\blink\b(?=.{0,120}\b(?:someone|somebody|some1|whoever|a\s+friend|my\s+friend|friends|my\s+friends|a\s+mate|my\s+mate|mates|my\s+mates|people|person|them|him|her)\b)(?=.{0,120}\b(?:can|could)?\s*(?:use\s+)?(?:to\s+)?(?:join|get\s+into|get\s+in|be\s+added)\b)(?=.{0,140}\b(?:(?:the|this|that|our|current)\s+){0,2}(?:group|chat|whatsapp|watsapp|wa|channel|community)\b)/iu,
  },
  {
    label: "link to add/invite someone to group",
    regex:
      /\blink\b(?=.{0,120}\b(?:add|invite)\b)(?=.{0,120}\b(?:someone|somebody|some1|whoever|a\s+friend|my\s+friend|friends|my\s+friends|a\s+mate|my\s+mate|mates|my\s+mates|people|person|them|him|her)\b)(?=.{0,140}\b(?:to|into|2)\s+(?:(?:the|this|that|our|current)\s+){0,2}(?:group|chat|whatsapp|watsapp|wa|channel|community)\b)/iu,
  },
  {
    label: "invite/add someone to group",
    regex:
      /\b(?:how\s+(?:can|do)\s+i\s+)?(?:invite(?:\s+add)?|add)\s+(?:me|someone|somebody|some1|whoever|a\s+friend|my\s+friend|friends|my\s+friends|a\s+mate|my\s+mate|mates|my\s+mates|people|person|them|him|her)\s+(?:to|into|2)\s+(?:(?:the|this|that|our|current)\s+){0,2}(?:group|chat|whatsapp|watsapp|wa|channel|community)\b/iu,
  },
  {
    label: "how to join group",
    regex:
      /\bhow\s+(?:can|do)\s+i\s+(?:join|get\s+into|get\s+in)\s+(?:(?:the|this|that|our|current)\s+){0,2}(?:group|chat|whatsapp|watsapp|wa|channel|community)\b/iu,
  },
];

export const classifyGroupInviteLinkRequest = (text: string): GroupInviteLinkClassification => {
  const normalisedText = normaliseText(text);

  if (!normalisedText) {
    return { matched: false, reason: null, matchedSignal: null };
  }

  const matchedPattern = HIGH_PRECISION_PATTERNS.find((pattern) => pattern.regex.test(normalisedText));

  if (!matchedPattern) {
    return { matched: false, reason: null, matchedSignal: null };
  }

  return {
    matched: true,
    reason: "group_invite_link_request",
    matchedSignal: matchedPattern.label,
  };
};

export const buildGroupInviteLinkReply = (mentionLabel: string): string =>
  `Hey ${mentionLabel} - if you're looking for the group invite link, please go to https://fete.outofofficecollective.co.uk. You can find it in the dropdown menu under the lightning bolt in the top right hand corner.`;
