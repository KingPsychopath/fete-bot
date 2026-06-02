export const CLEANUP_DM_RATE_LIMIT = {
  messagesPerWindow: 8,
  windowMinutes: 30,
  perMessageDelayMs: 10_000,
} as const;

export const cleanupDmRateLabel = (): string =>
  `${CLEANUP_DM_RATE_LIMIT.messagesPerWindow} every ${CLEANUP_DM_RATE_LIMIT.windowMinutes}m`;
