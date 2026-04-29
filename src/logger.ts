import pino from "pino";

type LogLevel = "debug" | "info" | "warn" | "error";
type ConfiguredLogLevel = LogLevel | "silent";
type LogFields = Record<string, unknown>;

const EVENT_MAX_LENGTH = 80;
const DEFAULT_LOG_LEVEL: ConfiguredLogLevel = process.env.VITEST ? "silent" : "info";

const normaliseEnvValue = (value: string | undefined): string | undefined => {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const firstChar = trimmed[0];
    const lastChar = trimmed[trimmed.length - 1];
    if ((firstChar === "\"" && lastChar === "\"") || (firstChar === "'" && lastChar === "'")) {
      return trimmed.slice(1, -1).trim();
    }
  }

  return trimmed;
};

const parseLogLevel = (value: string | undefined): ConfiguredLogLevel => {
  const level = normaliseEnvValue(value)?.toLowerCase();
  return level === "debug" || level === "info" || level === "warn" || level === "error" || level === "silent"
    ? level
    : DEFAULT_LOG_LEVEL;
};

const logger = pino({
  base: null,
  level: parseLogLevel(process.env.LOG_LEVEL),
  messageKey: "message",
  timestamp: pino.stdTimeFunctions.isoTime,
  formatters: {
    level: (label) => ({ level: label }),
  },
});

const isPlainObject = (value: unknown): value is LogFields =>
  typeof value === "object" &&
  value !== null &&
  !Array.isArray(value) &&
  !(value instanceof Error);

const serialiseError = (error: Error): LogFields => ({
  errorName: error.name,
  errorMessage: error.message,
  errorStack: error.stack,
});

const serialiseValue = (value: unknown): unknown => {
  if (value instanceof Error) {
    return serialiseError(value);
  }

  if (Array.isArray(value)) {
    return value.map(serialiseValue);
  }

  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, nestedValue]) => [key, serialiseValue(nestedValue)]),
    );
  }

  return value;
};

const serialiseFields = (fields: LogFields): LogFields => {
  const serialisedFields: LogFields = {};

  for (const [key, value] of Object.entries(fields)) {
    if (key === "error" && value instanceof Error) {
      Object.assign(serialisedFields, serialiseError(value));
      continue;
    }

    serialisedFields[key] = serialiseValue(value);
  }

  return serialisedFields;
};

const eventFromMessage = (message: string): string => {
  const trimmed = message.trim();
  if (/^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)+$/u.test(trimmed)) {
    return trimmed.slice(0, EVENT_MAX_LENGTH);
  }

  const event = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, ".")
    .replace(/^\.+|\.+$/gu, "")
    .slice(0, EVENT_MAX_LENGTH)
    .replace(/\.+$/u, "");

  return event || "app.log";
};

const splitArgs = (args: unknown[]): { message: string; fields: LogFields } => {
  const [first, ...rest] = args;
  const message = typeof first === "string" ? first : "app.log";
  const fields: LogFields = {};
  const extra: unknown[] = [];

  if (typeof first !== "string" && first !== undefined) {
    extra.push(first);
  }

  for (const value of rest) {
    if (isPlainObject(value)) {
      Object.assign(fields, serialiseFields(value));
      continue;
    }

    if (value instanceof Error) {
      Object.assign(fields, serialiseError(value));
      continue;
    }

    extra.push(serialiseValue(value));
  }

  if (extra.length > 0) {
    fields.extra = extra.length === 1 ? extra[0] : extra;
  }

  return {
    message,
    fields: {
      event: eventFromMessage(message),
      ...fields,
    },
  };
};

const write = (level: LogLevel, args: unknown[]): void => {
  const { message, fields } = splitArgs(args);
  logger[level](fields, message);
};

export const debug = (...args: unknown[]): void => {
  write("debug", args);
};

export const log = (...args: unknown[]): void => {
  write("info", args);
};

export const info = log;

export const warn = (...args: unknown[]): void => {
  write("warn", args);
};

export const error = (...args: unknown[]): void => {
  write("error", args);
};
