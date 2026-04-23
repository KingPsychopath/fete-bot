import { randomBytes } from "node:crypto";

import type { GroupMetadata } from "@whiskeysockets/baileys";

import {
  getDb,
  getIdentityMergesForUser,
  getUserAliases,
  getUserRecord,
  resolveTerminalUserId,
  withImmediateTransaction,
  type AliasType,
  type UserAliasRecord,
  type UserRecord,
} from "./db.js";
import { expandKnownAliases } from "./lidMap.js";
import { error, log, warn } from "./logger.js";
import { parseToJid } from "./utils.js";

export type JidClassification =
  | "user-phone"
  | "user-lid"
  | "group"
  | "newsletter"
  | "status"
  | "broadcast"
  | "self"
  | "unknown";

export type ParsedIdentifier = {
  input: string;
  alias: string;
  classification: "user-phone" | "user-lid";
};

export type UserSummary = {
  userId: string;
  shortId: string;
  createdAt: number;
  displayName: string | null;
  notes: string | null;
  mergedInto: string | null;
  aliases: UserAliasRecord[];
};

export type ResolvedUser = UserSummary & {
  participantJid: string | null;
  knownAliases: string[];
  isNew: boolean;
  mergedFrom: string[];
};

type ResolveUserInput = {
  participantJid?: string | null;
  phoneJid?: string | null;
  lidJid?: string | null;
  pushName?: string | null;
  selfJids?: ReadonlySet<string>;
  reason?: "alias_collision" | "metadata_sync" | "manual_admin";
};

type AliasRow = {
  alias: string;
  alias_type: AliasType;
  user_id: string;
  first_seen_at: number;
  last_seen_at: number;
};

type MergeReason = "alias_collision" | "metadata_sync" | "manual_admin";

type UserHit = {
  userId: string;
  terminalUserId: string;
};

const EMPTY_SELF_JIDS = new Set<string>();
const MAX_MERGE_DEPTH = 10;
const aliasMutexTails = new Map<string, Promise<void>>();

const splitJid = (jid: string): { user: string; server: string } | null => {
  const atIndex = jid.lastIndexOf("@");
  if (atIndex < 0) {
    return null;
  }

  return {
    user: jid.slice(0, atIndex),
    server: jid.slice(atIndex + 1),
  };
};

const stripDeviceSuffix = (user: string): string => {
  const colonIndex = user.indexOf(":");
  return colonIndex >= 0 ? user.slice(0, colonIndex) : user;
};

export const normalizeJid = (input: string): string => {
  const trimmed = input.trim().toLowerCase();
  const parts = splitJid(trimmed);
  if (!parts) {
    return trimmed;
  }

  if (parts.server === "s.whatsapp.net" || parts.server === "lid") {
    return `${stripDeviceSuffix(parts.user)}@${parts.server}`;
  }

  return `${parts.user}@${parts.server}`;
};

export const getShortUserId = (userId: string): string => userId.slice(0, 8);

const createUuidV7 = (): string => {
  const bytes = randomBytes(16);
  const timestamp = BigInt(Date.now());

  bytes[0] = Number((timestamp >> 40n) & 0xffn);
  bytes[1] = Number((timestamp >> 32n) & 0xffn);
  bytes[2] = Number((timestamp >> 24n) & 0xffn);
  bytes[3] = Number((timestamp >> 16n) & 0xffn);
  bytes[4] = Number((timestamp >> 8n) & 0xffn);
  bytes[5] = Number(timestamp & 0xffn);
  bytes[6] = (bytes[6] & 0x0f) | 0x70;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;

  const hex = bytes.toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
};

const lockAlias = async (alias: string): Promise<() => void> => {
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolve) => {
    releaseCurrent = resolve;
  });
  const previous = aliasMutexTails.get(alias) ?? Promise.resolve();
  aliasMutexTails.set(alias, previous.then(() => current));
  await previous;

  return () => {
    releaseCurrent();
    if (aliasMutexTails.get(alias) === current) {
      aliasMutexTails.delete(alias);
    }
  };
};

const withAliasLocks = async <T>(aliases: readonly string[], fn: () => T | Promise<T>): Promise<T> => {
  const unlockers: Array<() => void> = [];
  try {
    for (const alias of Array.from(new Set(aliases)).sort()) {
      unlockers.push(await lockAlias(alias));
    }

    return await fn();
  } finally {
    for (const unlock of unlockers.reverse()) {
      unlock();
    }
  }
};

const getUserRowsForAliases = (aliases: readonly string[]): AliasRow[] => {
  if (aliases.length === 0) {
    return [];
  }

  const placeholders = aliases.map(() => "?").join(", ");
  return getDb()
    .prepare<
      string[],
      {
        alias: string;
        alias_type: AliasType;
        user_id: string;
        first_seen_at: number;
        last_seen_at: number;
      }
    >(
      `SELECT alias, alias_type, user_id, first_seen_at, last_seen_at
       FROM user_aliases
       WHERE alias IN (${placeholders})`,
    )
    .all(...aliases)
    .map((row) => ({
      alias: row.alias,
      alias_type: row.alias_type,
      user_id: row.user_id,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
    }));
};

const getTerminalUserIdSafely = (userId: string): string => {
  try {
    return resolveTerminalUserId(userId, MAX_MERGE_DEPTH);
  } catch (resolveError) {
    warn("identity.merge.cycle_detected", {
      userId,
      error: resolveError instanceof Error ? resolveError.message : String(resolveError),
    });
    throw resolveError;
  }
};

const buildUserSummary = (record: UserRecord): UserSummary => {
  const terminalUserId = getTerminalUserIdSafely(record.id);
  const terminalRecord = getUserRecord(terminalUserId);
  if (!terminalRecord) {
    throw new Error(`Unable to build summary for unknown user ${terminalUserId}`);
  }

  return {
    userId: terminalRecord.id,
    shortId: getShortUserId(terminalRecord.id),
    createdAt: terminalRecord.createdAt,
    displayName: terminalRecord.displayName,
    notes: terminalRecord.notes,
    mergedInto: terminalRecord.mergedInto,
    aliases: getUserAliases(terminalRecord.id),
  };
};

const getAliasTypeForClassification = (classification: "user-phone" | "user-lid"): AliasType =>
  classification === "user-phone" ? "phone" : "lid";

const isTruthy = <T>(value: T | null | undefined): value is T => value !== null && value !== undefined;

const normalizeAndClassifyUserAlias = (
  alias: string | null | undefined,
  selfJids: ReadonlySet<string>,
): { alias: string; classification: "user-phone" | "user-lid" } | null => {
  if (!alias) {
    return null;
  }

  const normalizedAlias = normalizeJid(alias);
  const classification = classifyJid(normalizedAlias, selfJids);
  if (classification === "user-phone" || classification === "user-lid") {
    return { alias: normalizedAlias, classification };
  }

  return null;
};

const collectCandidateAliases = (
  input: ResolveUserInput,
): {
  aliases: string[];
  participantJid: string | null;
  phoneAlias: string | null;
  lidAlias: string | null;
} => {
  const selfJids = input.selfJids ?? EMPTY_SELF_JIDS;
  const participant = normalizeAndClassifyUserAlias(input.participantJid ?? null, selfJids);
  const phone = normalizeAndClassifyUserAlias(input.phoneJid ?? null, selfJids);
  const lid = normalizeAndClassifyUserAlias(input.lidJid ?? null, selfJids);

  const aliases = expandKnownAliases([
    participant?.alias ?? null,
    phone?.alias ?? null,
    lid?.alias ?? null,
  ])
    .map((alias) => normalizeAndClassifyUserAlias(alias, selfJids))
    .filter(isTruthy)
    .map((entry) => entry.alias);

  return {
    aliases: Array.from(new Set(aliases)).sort(),
    participantJid: participant?.alias ?? lid?.alias ?? phone?.alias ?? null,
    phoneAlias: phone?.alias ?? null,
    lidAlias: lid?.alias ?? null,
  };
};

export const classifyJid = (input: string, selfJids: ReadonlySet<string> = EMPTY_SELF_JIDS): JidClassification => {
  const normalizedJid = normalizeJid(input);
  if (!normalizedJid) {
    return "unknown";
  }

  if (selfJids.has(normalizedJid)) {
    return "self";
  }

  if (normalizedJid === "status@broadcast") {
    return "status";
  }

  if (normalizedJid.endsWith("@newsletter")) {
    return "newsletter";
  }

  if (normalizedJid.endsWith("@broadcast")) {
    return "broadcast";
  }

  if (normalizedJid.endsWith("@g.us")) {
    return "group";
  }

  if (/^\d{7,15}@s\.whatsapp\.net$/i.test(normalizedJid)) {
    return "user-phone";
  }

  if (/^[^@\s]+@lid$/i.test(normalizedJid)) {
    return "user-lid";
  }

  return "unknown";
};

export const parseIdentifier = (input: string): ParsedIdentifier | null => {
  const trimmed = input.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.toLowerCase().startsWith("lid:")) {
    const lidUser = trimmed.slice(4).trim().toLowerCase();
    if (!lidUser || /[@\s]/.test(lidUser)) {
      return null;
    }

    return {
      input,
      alias: normalizeJid(`${lidUser}@lid`),
      classification: "user-lid",
    };
  }

  const normalizedExistingJid = normalizeJid(trimmed);
  const existingClassification = classifyJid(normalizedExistingJid);
  if (existingClassification === "user-phone" || existingClassification === "user-lid") {
    return {
      input,
      alias: normalizedExistingJid,
      classification: existingClassification,
    };
  }

  const parsedPhoneJid = parseToJid(trimmed);
  if (!parsedPhoneJid) {
    return null;
  }

  return {
    input,
    alias: normalizeJid(parsedPhoneJid),
    classification: "user-phone",
  };
};

export const buildSelfJids = (user: { id?: string | null; lid?: string | null; phoneNumber?: string | null } | null | undefined): Set<string> => {
  const selfJids = new Set<string>();

  for (const candidate of [user?.id ?? null, user?.lid ?? null]) {
    const normalizedCandidate = candidate ? normalizeJid(candidate) : null;
    if (normalizedCandidate && (classifyJid(normalizedCandidate) === "user-phone" || classifyJid(normalizedCandidate) === "user-lid")) {
      selfJids.add(normalizedCandidate);
    }
  }

  const phoneAlias = user?.phoneNumber ? parseToJid(user.phoneNumber) : null;
  if (phoneAlias) {
    selfJids.add(normalizeJid(phoneAlias));
  }

  return selfJids;
};

const upsertAliasForUser = (userId: string, alias: string, aliasType: AliasType, seenAt: number): void => {
  getDb()
    .prepare<[string, AliasType, string, number, number]>(`
      INSERT INTO user_aliases (
        alias,
        alias_type,
        user_id,
        first_seen_at,
        last_seen_at
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(alias) DO UPDATE SET
        first_seen_at = MIN(user_aliases.first_seen_at, excluded.first_seen_at),
        last_seen_at = MAX(user_aliases.last_seen_at, excluded.last_seen_at)
    `)
    .run(alias, aliasType, userId, seenAt, seenAt);
};

const touchDisplayName = (userId: string, pushName: string | null | undefined): void => {
  const trimmedName = pushName?.trim();
  if (!trimmedName) {
    return;
  }

  getDb()
    .prepare<[string, string]>(`
      UPDATE users
      SET display_name = CASE
        WHEN display_name IS NULL OR TRIM(display_name) = '' THEN ?
        ELSE display_name
      END
      WHERE id = ?
    `)
    .run(trimmedName, userId);
};

const insertUser = (displayName: string | null | undefined): UserRecord => {
  const userId = createUuidV7();
  const createdAt = Date.now();
  getDb()
    .prepare<[string, number, string | null]>(`
      INSERT INTO users (
        id,
        created_at,
        display_name
      ) VALUES (?, ?, ?)
    `)
    .run(userId, createdAt, displayName?.trim() || null);

  const record = getUserRecord(userId);
  if (!record) {
    throw new Error(`Failed to create user ${userId}`);
  }

  return record;
};

const chooseSurvivorUserId = (userIds: readonly string[]): string => {
  const records = userIds
    .map((userId) => getUserRecord(userId))
    .filter(isTruthy)
    .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id));

  if (records.length === 0) {
    throw new Error("Unable to choose survivor user without records");
  }

  return records[0].id;
};

const mergeBanRows = (survivorUserId: string, mergedUserId: string): number => {
  const duplicateGroups = getDb()
    .prepare<[string, string], { group_jid: string }>(`
      SELECT survivor.group_jid
      FROM bans AS survivor
      INNER JOIN bans AS merged
        ON survivor.group_jid = merged.group_jid
      WHERE survivor.user_id = ? AND merged.user_id = ?
    `)
    .all(survivorUserId, mergedUserId);

  for (const { group_jid: groupJid } of duplicateGroups) {
    const rows = getDb()
      .prepare<
        [string, string, string],
        {
          user_id: string;
          banned_by_user_id: string | null;
          banned_by_label: string;
          reason: string | null;
          created_at: string;
        }
      >(`
        SELECT user_id, banned_by_user_id, banned_by_label, reason, created_at
        FROM bans
        WHERE group_jid = ? AND user_id IN (?, ?)
        ORDER BY created_at ASC
      `)
      .all(groupJid, survivorUserId, mergedUserId);

    const earliestRow = rows[0];
    const reason = rows.find((row) => row.reason)?.reason ?? null;
    getDb()
      .prepare<[string | null, string, string | null, string, string, string]>(`
        UPDATE bans
        SET banned_by_user_id = ?,
            banned_by_label = ?,
            reason = ?,
            created_at = ?
        WHERE user_id = ? AND group_jid = ?
      `)
      .run(
        earliestRow?.banned_by_user_id ?? null,
        earliestRow?.banned_by_label ?? "unknown",
        reason,
        earliestRow?.created_at ?? new Date().toISOString(),
        survivorUserId,
        groupJid,
      );

    getDb().prepare<[string, string]>("DELETE FROM bans WHERE user_id = ? AND group_jid = ?").run(mergedUserId, groupJid);
  }

  const result = getDb().prepare<[string, string]>("UPDATE bans SET user_id = ? WHERE user_id = ?").run(survivorUserId, mergedUserId);
  return result.changes + duplicateGroups.length;
};

const isLongerExpiry = (left: string | null, right: string | null): boolean => {
  if (left === null) {
    return true;
  }

  if (right === null) {
    return false;
  }

  return left > right;
};

const mergeMuteRows = (survivorUserId: string, mergedUserId: string): number => {
  const duplicateGroups = getDb()
    .prepare<[string, string], { group_jid: string }>(`
      SELECT survivor.group_jid
      FROM mutes AS survivor
      INNER JOIN mutes AS merged
        ON survivor.group_jid = merged.group_jid
      WHERE survivor.user_id = ? AND merged.user_id = ?
    `)
    .all(survivorUserId, mergedUserId);

  for (const { group_jid: groupJid } of duplicateGroups) {
    const rows = getDb()
      .prepare<
        [string, string, string],
        {
          user_id: string;
          muted_by_user_id: string | null;
          muted_by_label: string;
          reason: string | null;
          muted_at: string;
          expires_at: string | null;
        }
      >(`
        SELECT user_id, muted_by_user_id, muted_by_label, reason, muted_at, expires_at
        FROM mutes
        WHERE group_jid = ? AND user_id IN (?, ?)
        ORDER BY muted_at ASC
      `)
      .all(groupJid, survivorUserId, mergedUserId);

    const earliestRow = rows[0];
    const longestExpiry = rows.reduce<string | null>(
      (currentLongest, row) => (isLongerExpiry(row.expires_at, currentLongest) ? row.expires_at : currentLongest),
      rows[0]?.expires_at ?? null,
    );
    const reason = rows.find((row) => row.reason)?.reason ?? null;

    getDb()
      .prepare<[string | null, string, string | null, string, string | null, string, string]>(`
        UPDATE mutes
        SET muted_by_user_id = ?,
            muted_by_label = ?,
            reason = ?,
            muted_at = ?,
            expires_at = ?
        WHERE user_id = ? AND group_jid = ?
      `)
      .run(
        earliestRow?.muted_by_user_id ?? null,
        earliestRow?.muted_by_label ?? "unknown",
        reason,
        earliestRow?.muted_at ?? new Date().toISOString(),
        longestExpiry,
        survivorUserId,
        groupJid,
      );

    getDb().prepare<[string, string]>("DELETE FROM mutes WHERE user_id = ? AND group_jid = ?").run(mergedUserId, groupJid);
  }

  const result = getDb().prepare<[string, string]>("UPDATE mutes SET user_id = ? WHERE user_id = ?").run(survivorUserId, mergedUserId);
  return result.changes + duplicateGroups.length;
};

const mergeReviewQueueRows = (survivorUserId: string, mergedUserId: string): number => {
  const duplicateGroups = getDb()
    .prepare<[string, string], { group_jid: string }>(`
      SELECT survivor.group_jid
      FROM review_queue AS survivor
      INNER JOIN review_queue AS merged
        ON survivor.group_jid = merged.group_jid
      WHERE survivor.user_id = ? AND merged.user_id = ?
    `)
    .all(survivorUserId, mergedUserId);

  for (const { group_jid: groupJid } of duplicateGroups) {
    const rows = getDb()
      .prepare<
        [string, string, string],
        {
          user_id: string;
          push_name: string | null;
          reason: string;
          message_text: string | null;
          flagged_at: string;
          status: "pending" | "resolved";
        }
      >(`
        SELECT user_id, push_name, reason, message_text, flagged_at, status
        FROM review_queue
        WHERE group_jid = ? AND user_id IN (?, ?)
        ORDER BY flagged_at ASC
      `)
      .all(groupJid, survivorUserId, mergedUserId);

    const earliestRow = rows[0];
    const status = rows.some((row) => row.status === "pending") ? "pending" : "resolved";

    getDb()
      .prepare<[string | null, string, string | null, string, string, string, string]>(`
        UPDATE review_queue
        SET push_name = ?,
            reason = ?,
            message_text = ?,
            flagged_at = ?,
            status = ?
        WHERE user_id = ? AND group_jid = ?
      `)
      .run(
        earliestRow?.push_name ?? null,
        earliestRow?.reason ?? "unknown",
        earliestRow?.message_text ?? null,
        earliestRow?.flagged_at ?? new Date().toISOString(),
        status,
        survivorUserId,
        groupJid,
      );

    getDb().prepare<[string, string]>("DELETE FROM review_queue WHERE user_id = ? AND group_jid = ?").run(mergedUserId, groupJid);
  }

  const result = getDb()
    .prepare<[string, string]>("UPDATE review_queue SET user_id = ? WHERE user_id = ?")
    .run(survivorUserId, mergedUserId);
  return result.changes + duplicateGroups.length;
};

const mergeModeratorRows = (survivorUserId: string, mergedUserId: string): number => {
  const survivorModerator = getDb()
    .prepare<
      [string],
      {
        user_id: string;
        added_by_user_id: string | null;
        added_by_label: string;
        note: string | null;
        added_at: string;
      }
    >("SELECT user_id, added_by_user_id, added_by_label, note, added_at FROM moderators WHERE user_id = ?")
    .get(survivorUserId);
  const mergedModerator = getDb()
    .prepare<
      [string],
      {
        user_id: string;
        added_by_user_id: string | null;
        added_by_label: string;
        note: string | null;
        added_at: string;
      }
    >("SELECT user_id, added_by_user_id, added_by_label, note, added_at FROM moderators WHERE user_id = ?")
    .get(mergedUserId);

  if (!mergedModerator) {
    return 0;
  }

  if (!survivorModerator) {
    return getDb().prepare<[string, string]>("UPDATE moderators SET user_id = ? WHERE user_id = ?").run(survivorUserId, mergedUserId).changes;
  }

  const earliestModerator = survivorModerator.added_at <= mergedModerator.added_at ? survivorModerator : mergedModerator;
  getDb()
    .prepare<[string | null, string, string | null, string, string]>(`
      UPDATE moderators
      SET added_by_user_id = ?,
          added_by_label = ?,
          note = ?,
          added_at = ?
      WHERE user_id = ?
    `)
    .run(
      earliestModerator.added_by_user_id,
      earliestModerator.added_by_label,
      survivorModerator.note ?? mergedModerator.note,
      earliestModerator.added_at,
      survivorUserId,
    );

  getDb().prepare<[string]>("DELETE FROM moderators WHERE user_id = ?").run(mergedUserId);
  return 1;
};

const moveAliasesToSurvivor = (survivorUserId: string, mergedUserId: string): number => {
  const aliases = getDb()
    .prepare<[string], AliasRow>(`
      SELECT alias, alias_type, user_id, first_seen_at, last_seen_at
      FROM user_aliases
      WHERE user_id = ?
    `)
    .all(mergedUserId);

  for (const aliasRow of aliases) {
    getDb()
      .prepare<[string, AliasType, string, number, number]>(`
        INSERT INTO user_aliases (
          alias,
          alias_type,
          user_id,
          first_seen_at,
          last_seen_at
        ) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(alias) DO UPDATE SET
          user_id = excluded.user_id,
          first_seen_at = MIN(user_aliases.first_seen_at, excluded.first_seen_at),
          last_seen_at = MAX(user_aliases.last_seen_at, excluded.last_seen_at)
      `)
      .run(aliasRow.alias, aliasRow.alias_type, survivorUserId, aliasRow.first_seen_at, aliasRow.last_seen_at);
  }

  return getDb().prepare<[string]>("DELETE FROM user_aliases WHERE user_id = ?").run(mergedUserId).changes;
};

const performMerge = (
  survivorUserId: string,
  mergedUserId: string,
  reason: MergeReason,
  triggerPhoneAlias: string | null,
  triggerLidAlias: string | null,
): { mergedFrom: string; repointCounts: Record<string, number> } => {
  if (survivorUserId === mergedUserId) {
    return { mergedFrom: mergedUserId, repointCounts: {} };
  }

  const repointCounts = {
    logs: getDb().prepare<[string, string]>("UPDATE logs SET user_id = ? WHERE user_id = ?").run(survivorUserId, mergedUserId).changes,
    strikes: getDb().prepare<[string, string]>("UPDATE strikes SET user_id = ? WHERE user_id = ?").run(survivorUserId, mergedUserId).changes,
    bans: 0,
    mutes: 0,
    reviewQueue: 0,
    moderators: 0,
    auditActors: getDb().prepare<[string, string]>("UPDATE audit_log SET actor_user_id = ? WHERE actor_user_id = ?").run(survivorUserId, mergedUserId).changes,
    auditTargets: getDb().prepare<[string, string]>("UPDATE audit_log SET target_user_id = ? WHERE target_user_id = ?").run(survivorUserId, mergedUserId).changes,
    aliases: 0,
  };

  repointCounts.bans = mergeBanRows(survivorUserId, mergedUserId);
  repointCounts.mutes = mergeMuteRows(survivorUserId, mergedUserId);
  repointCounts.reviewQueue = mergeReviewQueueRows(survivorUserId, mergedUserId);
  repointCounts.moderators = mergeModeratorRows(survivorUserId, mergedUserId);
  repointCounts.aliases = moveAliasesToSurvivor(survivorUserId, mergedUserId);

  getDb()
    .prepare<[string, string]>("UPDATE users SET merged_into = ? WHERE id = ?")
    .run(survivorUserId, mergedUserId);

  getDb()
    .prepare<[string, string, string, MergeReason, number, string | null, string | null]>(`
      INSERT INTO identity_merges (
        id,
        survivor_user_id,
        merged_user_id,
        reason,
        merged_at,
        trigger_alias_phone,
        trigger_alias_lid
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `)
    .run(createUuidV7(), survivorUserId, mergedUserId, reason, Date.now(), triggerPhoneAlias, triggerLidAlias);

  return {
    mergedFrom: mergedUserId,
    repointCounts,
  };
};

const findDistinctHits = (aliases: readonly string[]): UserHit[] => {
  const hits = new Map<string, UserHit>();
  for (const row of getUserRowsForAliases(aliases)) {
    const terminalUserId = getTerminalUserIdSafely(row.user_id);
    hits.set(row.user_id, {
      userId: row.user_id,
      terminalUserId,
    });
  }

  return Array.from(hits.values());
};

const buildResolvedUser = (
  userId: string,
  participantJid: string | null,
  isNew: boolean,
  mergedFrom: string[],
): ResolvedUser => {
  const summary = getUserSummary(userId);
  if (!summary) {
    throw new Error(`Unable to build resolved user for ${userId}`);
  }

  return {
    ...summary,
    participantJid,
    knownAliases: summary.aliases.map((alias) => alias.alias),
    isNew,
    mergedFrom,
  };
};

export const resolveUser = async (input: ResolveUserInput): Promise<ResolvedUser | null> => {
  const selfJids = input.selfJids ?? EMPTY_SELF_JIDS;
  const { aliases, participantJid, phoneAlias, lidAlias } = collectCandidateAliases({
    ...input,
    selfJids,
  });

  if (aliases.length === 0) {
    log("identity.resolve.rejected", {
      reason: "no_user_aliases",
      participantJid: input.participantJid ?? null,
      phoneJid: input.phoneJid ?? null,
      lidJid: input.lidJid ?? null,
    });
    return null;
  }

  return withAliasLocks(aliases, async () => {
    const resolution = withImmediateTransaction(() => {
      const hits = findDistinctHits(aliases);
      const distinctTerminalUserIds = Array.from(new Set(hits.map((hit) => hit.terminalUserId)));
      const mergedFrom: string[] = [];
      let isNew = false;
      let resolvedUserId = "";

      if (distinctTerminalUserIds.length === 0) {
        const userRecord = insertUser(input.pushName ?? null);
        resolvedUserId = userRecord.id;
        isNew = true;
        log("identity.user.created", {
          userId: userRecord.id,
          shortId: getShortUserId(userRecord.id),
        });
      } else if (distinctTerminalUserIds.length === 1) {
        resolvedUserId = distinctTerminalUserIds[0] ?? "";
      } else {
        const survivorUserId = chooseSurvivorUserId(distinctTerminalUserIds);
        resolvedUserId = survivorUserId;
        for (const terminalUserId of distinctTerminalUserIds) {
          if (terminalUserId === survivorUserId) {
            continue;
          }

          const mergeResult = performMerge(
            survivorUserId,
            terminalUserId,
            input.reason ?? "alias_collision",
            phoneAlias,
            lidAlias,
          );
          mergedFrom.push(mergeResult.mergedFrom);
          log("identity.merge.performed", {
            survivorUserId,
            mergedUserId: terminalUserId,
            shortId: getShortUserId(survivorUserId),
            repointCounts: mergeResult.repointCounts,
          });
        }
      }

      for (const alias of aliases) {
        const classification = classifyJid(alias, selfJids);
        if (classification !== "user-phone" && classification !== "user-lid") {
          continue;
        }

        const existingAliasRow = getUserRowsForAliases([alias])[0] ?? null;
        upsertAliasForUser(resolvedUserId, alias, getAliasTypeForClassification(classification), Date.now());
        if (!existingAliasRow) {
          log("identity.alias.created", {
            userId: resolvedUserId,
            shortId: getShortUserId(resolvedUserId),
            alias,
            aliasType: classification === "user-phone" ? "phone" : "lid",
          });
        } else if (existingAliasRow.user_id !== resolvedUserId) {
          log("identity.alias.attached", {
            userId: resolvedUserId,
            shortId: getShortUserId(resolvedUserId),
            alias,
            previousUserId: existingAliasRow.user_id,
          });
        }
      }

      touchDisplayName(resolvedUserId, input.pushName ?? null);

      return buildResolvedUser(resolvedUserId, participantJid, isNew, mergedFrom);
    });

    return resolution;
  });
};

export const getUserSummary = (userId: string): UserSummary | null => {
  const userRecord = getUserRecord(userId);
  if (!userRecord) {
    return null;
  }

  return buildUserSummary(userRecord);
};

export const findExistingUserByAliases = (aliases: ReadonlyArray<string | null | undefined>): UserSummary | null => {
  const normalizedAliases = expandKnownAliases(
    aliases
      .filter(isTruthy)
      .map((alias) => normalizeJid(alias)),
  ).sort();

  if (normalizedAliases.length === 0) {
    return null;
  }

  const hits = findDistinctHits(normalizedAliases);
  const terminalUserIds = Array.from(new Set(hits.map((hit) => hit.terminalUserId)));
  if (terminalUserIds.length === 0) {
    return null;
  }

  if (terminalUserIds.length > 1) {
    warn("identity.resolve.rejected", {
      reason: "ambiguous_existing_aliases",
      aliases: normalizedAliases,
      terminalUserIds,
    });
    return null;
  }

  return getUserSummary(terminalUserIds[0] ?? "");
};

export const findUserByIdentifier = (input: string): UserSummary | null => {
  const parsed = parseIdentifier(input);
  if (!parsed) {
    return null;
  }

  return findExistingUserByAliases([parsed.alias]);
};

export const resolveTargetFromIdentifier = async (
  input: string,
  selfJids: ReadonlySet<string>,
  pushName?: string | null,
): Promise<ResolvedUser | null> => {
  const parsed = parseIdentifier(input);
  if (!parsed) {
    return null;
  }

  return resolveUser({
    participantJid: parsed.classification === "user-lid" ? parsed.alias : null,
    phoneJid: parsed.classification === "user-phone" ? parsed.alias : null,
    lidJid: parsed.classification === "user-lid" ? parsed.alias : null,
    pushName: pushName ?? null,
    selfJids,
    reason: "manual_admin",
  });
};

const getParticipantAliases = (participant: GroupMetadata["participants"][number]): string[] =>
  expandKnownAliases([
    participant.id ? normalizeJid(participant.id) : null,
    participant.lid ? normalizeJid(participant.lid) : null,
    participant.phoneNumber ? parseToJid(participant.phoneNumber) : null,
  ]);

export const resolveParticipantTarget = async (
  participantJid: string,
  groupMetadata: GroupMetadata | null | undefined,
  selfJids: ReadonlySet<string>,
  pushName?: string | null,
): Promise<ResolvedUser | null> => {
  const normalizedParticipantJid = normalizeJid(participantJid);
  const matchingParticipant = groupMetadata?.participants.find((participant) =>
    getParticipantAliases(participant).includes(normalizedParticipantJid),
  );

  return resolveUser({
    participantJid: matchingParticipant?.id ?? participantJid,
    phoneJid: matchingParticipant?.phoneNumber ? parseToJid(matchingParticipant.phoneNumber) : null,
    lidJid: matchingParticipant?.lid ?? (normalizedParticipantJid.endsWith("@lid") ? normalizedParticipantJid : null),
    pushName: pushName ?? null,
    selfJids,
    reason: "metadata_sync",
  });
};

export const findParticipantJidForUser = (
  userId: string,
  groupMetadata: GroupMetadata | null | undefined,
): string | null => {
  if (!groupMetadata) {
    warn("identity.participant.jid_missing", {
      userId,
      reason: "missing_group_metadata",
    });
    return null;
  }

  const userAliases = new Set(getUserAliases(userId).map((alias) => alias.alias));
  for (const participant of groupMetadata.participants) {
    const aliases = getParticipantAliases(participant);
    if (!aliases.some((alias) => userAliases.has(alias))) {
      continue;
    }

    const liveParticipantJid = participant.id ?? participant.lid ?? null;
    if (liveParticipantJid) {
      return normalizeJid(liveParticipantJid);
    }
  }

  warn("identity.participant.jid_missing", {
    userId,
    groupJid: groupMetadata.id,
  });
  return null;
};

export const describeUser = (userId: string): UserSummary & {
  mergeHistory: ReturnType<typeof getIdentityMergesForUser>;
} | null => {
  const summary = getUserSummary(userId);
  if (!summary) {
    return null;
  }

  return {
    ...summary,
    mergeHistory: getIdentityMergesForUser(summary.userId),
  };
};
