// Mirrors the notifications.type and subject_type enums (migration 010).
export const NOTIFICATION_TYPES = [
  'post_comment',
  'comment_reply',
  'community_post',
  'report_resolved',
  'restriction_applied',
  'restriction_lifted',
  'content_removed',
] as const;

export type NotificationType = (typeof NOTIFICATION_TYPES)[number];

export const NOTIFICATION_SUBJECT_TYPES = [
  'post',
  'comment',
  'report',
  'restriction',
  'community',
] as const;

export type NotificationSubjectType =
  (typeof NOTIFICATION_SUBJECT_TYPES)[number];

export interface NotificationMetadata {
  actor_username?: string;
  community_name?: string;
  post_title?: string;
  excerpt?: string;
}

type MetadataField = keyof NotificationMetadata;

// Identifiers are bounded by their source columns (users.username,
// communities.name); a longer value is a producer bug and is rejected.
const identifierLimits = { actor_username: 50, community_name: 50 } as const;

// Content snapshots are truncated to this many code points, ellipsis included.
const snapshotLimits = { post_title: 120, excerpt: 200 } as const;

// Moderation outcomes never carry the moderator's username, and platform-level
// types carry no content snapshot.
const allowedFields: Record<NotificationType, readonly MetadataField[]> = {
  post_comment: ['actor_username', 'community_name', 'post_title', 'excerpt'],
  comment_reply: ['actor_username', 'community_name', 'post_title', 'excerpt'],
  community_post: ['actor_username', 'community_name', 'post_title', 'excerpt'],
  report_resolved: [],
  restriction_applied: [],
  restriction_lifted: [],
  content_removed: ['community_name', 'post_title', 'excerpt'],
};

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Notification metadata must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function truncate(value: string, limit: number): string {
  const codePoints = Array.from(value);
  return codePoints.length <= limit
    ? value
    : `${codePoints.slice(0, limit - 1).join('')}…`;
}

function fieldValue(
  metadata: Record<string, unknown>,
  key: MetadataField,
): string | undefined {
  const value = metadata[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  if (key === 'post_title' || key === 'excerpt') {
    return truncate(value, snapshotLimits[key]);
  }
  if (value.length === 0 || Array.from(value).length > identifierLimits[key]) {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

export function buildNotificationMetadata(
  type: NotificationType,
  metadata: unknown,
): NotificationMetadata | null {
  const input = metadataObject(metadata);
  const result: NotificationMetadata = {};

  for (const key of allowedFields[type]) {
    const value = fieldValue(input, key);
    if (value !== undefined) {
      result[key] = value;
    }
  }

  return Object.keys(result).length === 0 ? null : result;
}
