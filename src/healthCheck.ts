import {
  areJidsSameUser,
  jidNormalizedUser,
  type GroupMetadata,
  type WASocket,
} from "@whiskeysockets/baileys";

import type { Config } from "./config.js";
import { testDbWritable } from "./db.js";
import { error, log, warn } from "./logger.js";
import { parseToJid } from "./utils.js";

type HealthResult = {
  criticalFailures: string[];
};

const getBotIdentifiers = (sock: WASocket): Set<string> => {
  const identifiers = new Set<string>();
  const user = sock.user;

  if (user?.id) {
    identifiers.add(jidNormalizedUser(user.id));
  }

  if (user?.phoneNumber) {
    const parsed = parseToJid(user.phoneNumber);
    if (parsed) {
      identifiers.add(jidNormalizedUser(parsed));
    }
  }

  if (user?.lid) {
    identifiers.add(jidNormalizedUser(user.lid));
  }

  return identifiers;
};

export async function runStartupHealthCheck(
  sock: WASocket,
  config: Config,
  groups: Map<string, GroupMetadata>,
): Promise<HealthResult> {
  const criticalFailures: string[] = [];
  const botIdentifiers = getBotIdentifiers(sock);

  for (const allowedGroupJid of config.allowedGroupJids) {
    if (!groups.has(allowedGroupJid)) {
      criticalFailures.push(`Configured group missing from fetched groups: ${allowedGroupJid}`);
    }
  }

  for (const allowedGroupJid of config.allowedGroupJids) {
    const group = groups.get(allowedGroupJid);
    if (!group) {
      continue;
    }

    const botParticipant = group.participants.find((participant) => {
      const possibleIds = [participant.id, participant.lid, participant.phoneNumber]
        .map((value) => (value ? parseToJid(value) ?? value : null))
        .filter((value): value is string => Boolean(value));

      return possibleIds.some((value) => {
        const normalised = jidNormalizedUser(value);
        if (botIdentifiers.has(normalised)) {
          return true;
        }

        return Array.from(botIdentifiers).some((botId) => areJidsSameUser(botId, value));
      });
    });

    if (!botParticipant?.admin && !botParticipant?.isAdmin && !botParticipant?.isSuperAdmin) {
      criticalFailures.push(`Bot is not admin in monitored group: ${allowedGroupJid}`);
    }
  }

  for (const ownerJid of config.ownerJids) {
    if (parseToJid(ownerJid) !== ownerJid) {
      criticalFailures.push(`Owner JID has invalid format: ${ownerJid}`);
    }
  }

  try {
    testDbWritable();
    log("Health check: SQLite writable");
  } catch (dbError) {
    criticalFailures.push(`SQLite writable test failed: ${dbError instanceof Error ? dbError.message : String(dbError)}`);
  }

  if (criticalFailures.length === 0) {
    log("Health check passed", {
      monitoredGroups: config.allowedGroupJids.length,
      ownerJids: config.ownerJids.length,
    });
    return { criticalFailures };
  }

  for (const failure of criticalFailures) {
    warn("Health check critical failure", failure);
  }

  const dmText = `⚠️ Fete Bot startup health check found critical issues:

${criticalFailures.map((failure) => `• ${failure}`).join("\n")}

The bot is still running, but these should be reviewed.`;

  for (const ownerJid of config.ownerJids) {
    try {
      await sock.sendMessage(ownerJid, { text: dmText });
    } catch (dmError) {
      error("Failed to DM owner about health check failure", {
        ownerJid,
        error: dmError,
      });
    }
  }

  return { criticalFailures };
}
