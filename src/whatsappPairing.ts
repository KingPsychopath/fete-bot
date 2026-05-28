export type WhatsAppPairingCreds = {
  registered?: boolean;
  me?: {
    id?: string | null;
    lid?: string | null;
  } | null;
};

const hasText = (value: string | null | undefined): boolean => Boolean(value?.trim());

export const hasLinkedWhatsAppIdentity = (creds: WhatsAppPairingCreds): boolean =>
  creds.registered === true || hasText(creds.me?.id) || hasText(creds.me?.lid);

export const shouldRequestWhatsAppPairingCode = (
  creds: WhatsAppPairingCreds,
  pairingPhoneDigits: string | null,
): boolean => Boolean(pairingPhoneDigits && !hasLinkedWhatsAppIdentity(creds));
