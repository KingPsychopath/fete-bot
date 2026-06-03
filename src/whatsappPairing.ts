export type WhatsAppPairingCreds = {
  registered?: boolean;
  me?: {
    id?: string | null;
    lid?: string | null;
  } | null;
};

export const hasLinkedWhatsAppIdentity = (creds: WhatsAppPairingCreds): boolean =>
  creds.registered === true;

export const shouldRequestWhatsAppPairingCode = (
  creds: WhatsAppPairingCreds,
  pairingPhoneDigits: string | null,
): boolean => Boolean(pairingPhoneDigits && !hasLinkedWhatsAppIdentity(creds));
