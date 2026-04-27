const DEFAULT_TIME_ZONE = "Europe/London";

export type LocalDateTime = {
  date: string;
  time: string;
  timezone: string;
};

const getParts = (date: Date, timeZone: string): Record<string, string> => {
  const formatterOptions = {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  } as const;

  try {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", formatterOptions)
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  } catch {
    return Object.fromEntries(
      new Intl.DateTimeFormat("en-GB", { ...formatterOptions, timeZone: DEFAULT_TIME_ZONE })
        .formatToParts(date)
        .map((part) => [part.type, part.value]),
    );
  }
};

const toLocalComparable = (date: Date, timeZone: string): string => {
  const parts = getParts(date, timeZone);
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}`;
};

const localComparable = (local: LocalDateTime): string => `${local.date}T${local.time}`;

export const isValidLocalDate = (value: string): boolean => {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) {
    return false;
  }

  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === (month ?? 1) - 1 &&
    date.getUTCDate() === day
  );
};

export const isValidLocalTime = (value: string): boolean => /^([01]\d|2[0-3]):[0-5]\d$/u.test(value);

export const nowLocalDate = (now: Date, timezone: string): string => {
  const parts = getParts(now, timezone);
  return `${parts.year}-${parts.month}-${parts.day}`;
};

export const isDue = (local: LocalDateTime, now = new Date()): boolean =>
  toLocalComparable(now, local.timezone) >= localComparable(local);

export const addDaysToLocalDate = (date: string, days: number): string => {
  const [year, month, day] = date.split("-").map(Number);
  const next = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
};

export const nextLocalFromNow = (
  now: Date,
  timezone: string,
  time: string,
  intervalDays: number,
): LocalDateTime => ({
  date: addDaysToLocalDate(nowLocalDate(now, timezone), intervalDays),
  time,
  timezone,
});

export const advanceLocalSchedule = (
  local: LocalDateTime,
  intervalDays: number,
  now = new Date(),
): LocalDateTime => {
  let next = { ...local };
  do {
    next = {
      ...next,
      date: addDaysToLocalDate(next.date, intervalDays),
    };
  } while (isDue(next, now));

  return next;
};

export const formatLocalSchedule = (local: LocalDateTime): string =>
  `${local.date} ${local.time} (${local.timezone})`;
