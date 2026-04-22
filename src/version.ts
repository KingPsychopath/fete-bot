export const VERSION = process.env.GIT_COMMIT_SHA?.slice(0, 7) ?? "dev";
export const STARTED_AT = new Date().toISOString();
