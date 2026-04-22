type ConsoleMethod = (...args: unknown[]) => void;

const write = (method: ConsoleMethod, level: string, args: unknown[]): void => {
  method(`[${new Date().toISOString()}] [${level}]`, ...args);
};

export const log = (...args: unknown[]): void => {
  write(console.log, "INFO", args);
};

export const warn = (...args: unknown[]): void => {
  write(console.warn, "WARN", args);
};

export const error = (...args: unknown[]): void => {
  write(console.error, "ERROR", args);
};
