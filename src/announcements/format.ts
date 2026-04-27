import { formatLocalSchedule } from "./time.js";
import type {
  AnnouncementCycleRow,
  AnnouncementQueueItemRow,
  AnnouncementState,
} from "./store.js";

const STATUS_ICON: Record<AnnouncementQueueItemRow["status"], string> = {
  draft: "draft",
  published: "live",
};

export const formatPreview = (text: string, maxLength = 100): string => {
  const trimmed = text.trim().replace(/\s+/gu, " ");
  if (!trimmed) {
    return "(empty)";
  }

  if (trimmed.length <= maxLength) {
    return trimmed;
  }

  const slice = trimmed.slice(0, maxLength - 1);
  const lastSpace = slice.lastIndexOf(" ");
  const wordSafe = lastSpace >= Math.floor(maxLength * 0.6) ? slice.slice(0, lastSpace) : slice;
  return `${wordSafe.trimEnd()}...`;
};

export const formatQueueList = (items: readonly AnnouncementQueueItemRow[]): string => {
  if (items.length === 0) {
    return "Announcement queue is empty.";
  }

  const lines = items.map((item) => {
    const enabled = item.enabled ? "on" : "off";
    const updated = new Date(item.updatedAt).toLocaleString("en-GB", {
      dateStyle: "short",
      timeStyle: "short",
      timeZone: "Europe/London",
    });
    return `${item.position}. ${item.id.slice(0, 8)} | ${STATUS_ICON[item.status]} | ${enabled} | updated ${updated} | ${formatPreview(item.body)}`;
  });

  return `Announcement queue (${items.length}):\n\n${lines.join("\n")}`;
};

export const formatQueueItem = (item: AnnouncementQueueItemRow): string => `Announcement ${item.position} (${item.id})
Status: ${item.status}
Enabled: ${item.enabled ? "on" : "off"}
Updated: ${item.updatedAt}

${item.body}`;

const escapeCodeFence = (text: string): string => text.replaceAll("```", "`\u200b``");

export const formatRawQueueItem = (item: AnnouncementQueueItemRow): string => `Raw announcement ${item.position} (${item.id})
Copy the text inside this block, edit it, then reply to the edited text with:
!announce edit ${item.position}

\`\`\`
${escapeCodeFence(item.body)}
\`\`\``;

export const formatBundlePreview = (items: readonly AnnouncementQueueItemRow[]): string => {
  const active = items.filter((item) => item.status === "published" && item.enabled);
  if (active.length === 0) {
    return "No active published announcement items.";
  }

  return active.map((item) => `--- Message ${item.position} (${item.id.slice(0, 8)}) ---\n${item.body}`).join("\n\n");
};

export const formatNextAnnouncement = (
  state: AnnouncementState,
  activeCount: number,
  targetLabel: string,
  lastCycle: AnnouncementCycleRow | null,
): string => {
  const paused = state.paused ? "paused" : "running";
  const last = lastCycle
    ? `${lastCycle.status} at ${lastCycle.completedAt ?? lastCycle.updatedAt}${lastCycle.error ? ` (${lastCycle.error})` : ""}`
    : "none";

  return `Announcements: ${paused}
Target: ${targetLabel}
Next send: ${formatLocalSchedule({
    date: state.nextLocalDate,
    time: state.nextLocalTime,
    timezone: state.timezone,
  })}
Active published items: ${activeCount}
Last cycle: ${last}`;
};
