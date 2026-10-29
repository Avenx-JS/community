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

// Optional snapshot of the actor and community, kept so a row stays readable
// after either is deleted or renamed.
interface CommunitySnapshot {
  actor_username?: string;
  community_name?: string;
}

// Moderation types carry actorId: null so the acting moderator or
// administrator is never disclosed to the affected user.
export type NotificationEntry =
  | {
      recipientId: string;
      type: 'post_comment';
      actorId: string;
      subjectType: 'comment';
      subjectId: string;
      communityId: string;
      metadata: CommunitySnapshot & {
        post_id: string;
        post_title: string;
        excerpt: string;
      };
    }
  | {
      recipientId: string;
      type: 'comment_reply';
      actorId: string;
      subjectType: 'comment';
      subjectId: string;
      communityId: string;
      metadata: CommunitySnapshot & {
        post_id: string;
        parent_comment_id: string;
        post_title?: string;
        excerpt: string;
      };
    }
  | {
      recipientId: string;
      type: 'community_post';
      actorId: string;
      subjectType: 'post';
      subjectId: string;
      communityId: string;
      metadata: CommunitySnapshot & { post_title: string; excerpt?: string };
    }
  | {
      recipientId: string;
      type: 'report_resolved';
      actorId: null;
      subjectType: 'report';
      subjectId: string;
      communityId: null;
      metadata: { status: 'resolved' | 'rejected' };
    }
  | {
      recipientId: string;
      type: 'restriction_applied';
      actorId: null;
      subjectType: 'restriction';
      subjectId: string;
      communityId: null;
      metadata: { restriction_type: 'suspension' | 'ban'; expires_at?: string };
    }
  | {
      recipientId: string;
      type: 'restriction_lifted';
      actorId: null;
      subjectType: 'restriction';
      subjectId: string;
      communityId: null;
      metadata: { restriction_type: 'suspension' | 'ban' };
    }
  | {
      recipientId: string;
      type: 'content_removed';
      actorId: null;
      subjectType: 'post' | 'comment';
      subjectId: string;
      communityId: string;
      metadata: {
        community_name?: string;
        post_title?: string;
        excerpt?: string;
      };
    };

export type NotificationMetadata = Partial<Record<string, string>>;

// Runtime counterpart of the union, for callers that bypass the compiler.
const entryShapes: Record<
  NotificationType,
  {
    subjectTypes: readonly NotificationSubjectType[];
    hasActor: boolean;
    hasCommunity: boolean;
  }
> = {
  post_comment: {
    subjectTypes: ['comment'],
    hasActor: true,
    hasCommunity: true,
  },
  comment_reply: {
    subjectTypes: ['comment'],
    hasActor: true,
    hasCommunity: true,
  },
  community_post: {
    subjectTypes: ['post'],
    hasActor: true,
    hasCommunity: true,
  },
  report_resolved: {
    subjectTypes: ['report'],
    hasActor: false,
    hasCommunity: false,
  },
  restriction_applied: {
    subjectTypes: ['restriction'],
    hasActor: false,
    hasCommunity: false,
  },
  restriction_lifted: {
    subjectTypes: ['restriction'],
    hasActor: false,
    hasCommunity: false,
  },
  content_removed: {
    subjectTypes: ['post', 'comment'],
    hasActor: false,
    hasCommunity: true,
  },
};

const IDENTIFIER_PATTERN = /^[A-Za-z0-9_-]{1,36}$/;

// Names are bounded by their source columns (users.username,
// communities.name); a longer value is a producer bug and is rejected.
const nameLimits = { actor_username: 50, community_name: 50 } as const;

// Content snapshots are truncated to this many code points, ellipsis
// included. post_title matches the posts.title column; excerpt is taken from
// the start of the comment or post body.
export const NOTIFICATION_SNAPSHOT_LIMITS = {
  post_title: 300,
  excerpt: 200,
} as const;

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER_PATTERN.test(value);
}

// Throws TypeError unless the entry's type, subject type, actor and community
// agree with the union above. Metadata is checked by buildNotificationMetadata.
export function assertNotificationEntry(entry: NotificationEntry): void {
  const shape = (entryShapes as Partial<typeof entryShapes>)[entry.type];
  if (!shape) {
    throw new TypeError('Invalid notification type');
  }
  if (!shape.subjectTypes.includes(entry.subjectType)) {
    throw new TypeError(
      `Invalid notification subject type for ${entry.type}: ${entry.subjectType}`,
    );
  }
  if (!isIdentifier(entry.recipientId) || !isIdentifier(entry.subjectId)) {
    throw new TypeError('Invalid notification identifier');
  }
  if (shape.hasActor ? !isIdentifier(entry.actorId) : entry.actorId !== null) {
    throw new TypeError(`Invalid notification actor for ${entry.type}`);
  }
  if (
    shape.hasCommunity
      ? !isIdentifier(entry.communityId)
      : entry.communityId !== null
  ) {
    throw new TypeError(`Invalid notification community for ${entry.type}`);
  }
}

function metadataObject(value: unknown): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('Notification metadata must be an object');
  }
  return Object.fromEntries(Object.entries(value));
}

function stringValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = metadata[key];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

function identifierValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringValue(metadata, key);
  if (value !== undefined && !IDENTIFIER_PATTERN.test(value)) {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

function nameValue(
  metadata: Record<string, unknown>,
  key: keyof typeof nameLimits,
): string | undefined {
  const value = stringValue(metadata, key);
  if (
    value !== undefined &&
    (value.length === 0 || Array.from(value).length > nameLimits[key])
  ) {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

// Truncates by code point, so a multi-byte character is never split.
function snapshotValue(
  metadata: Record<string, unknown>,
  key: keyof typeof NOTIFICATION_SNAPSHOT_LIMITS,
): string | undefined {
  const value = stringValue(metadata, key);
  if (value === undefined) {
    return undefined;
  }
  const limit = NOTIFICATION_SNAPSHOT_LIMITS[key];
  const codePoints = Array.from(value);
  return codePoints.length <= limit
    ? value
    : `${codePoints.slice(0, limit - 1).join('')}…`;
}

function isoDateValue(
  metadata: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = stringValue(metadata, key);
  if (
    value !== undefined &&
    (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(
      value,
    ) ||
      !Number.isFinite(Date.parse(value)))
  ) {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

function enumValue(
  metadata: Record<string, unknown>,
  key: string,
  allowed: readonly string[],
): string | undefined {
  const value = stringValue(metadata, key);
  if (value !== undefined && !allowed.includes(value)) {
    throw new TypeError(`Invalid notification metadata field: ${key}`);
  }
  return value;
}

// Builds the stored snapshot from a per-type allowlist. Unknown keys are
// dropped; malformed allowed values throw. Returns null when nothing survives,
// so the column stores SQL NULL rather than {}.
export function buildNotificationMetadata(
  entry: NotificationEntry,
): NotificationMetadata | null {
  const metadata = metadataObject(entry.metadata);
  const fields: Array<[string, string | undefined]> = [];

  switch (entry.type) {
    case 'post_comment':
    case 'comment_reply':
    case 'community_post':
      fields.push(
        ['actor_username', nameValue(metadata, 'actor_username')],
        ['community_name', nameValue(metadata, 'community_name')],
      );
      if (entry.type !== 'community_post') {
        fields.push(['post_id', identifierValue(metadata, 'post_id')]);
      }
      if (entry.type === 'comment_reply') {
        fields.push([
          'parent_comment_id',
          identifierValue(metadata, 'parent_comment_id'),
        ]);
      }
      fields.push(
        ['post_title', snapshotValue(metadata, 'post_title')],
        ['excerpt', snapshotValue(metadata, 'excerpt')],
      );
      break;
    case 'report_resolved':
      fields.push([
        'status',
        enumValue(metadata, 'status', ['resolved', 'rejected']),
      ]);
      break;
    case 'restriction_applied':
    case 'restriction_lifted':
      fields.push([
        'restriction_type',
        enumValue(metadata, 'restriction_type', ['suspension', 'ban']),
      ]);
      if (entry.type === 'restriction_applied') {
        fields.push(['expires_at', isoDateValue(metadata, 'expires_at')]);
      }
      break;
    case 'content_removed':
      // Never the moderator's username.
      fields.push(
        ['community_name', nameValue(metadata, 'community_name')],
        ['post_title', snapshotValue(metadata, 'post_title')],
        ['excerpt', snapshotValue(metadata, 'excerpt')],
      );
      break;
    default:
      throw new TypeError('Invalid notification type');
  }

  const result: NotificationMetadata = {};
  for (const [key, value] of fields) {
    if (value !== undefined) {
      result[key] = value;
    }
  }
  return Object.keys(result).length === 0 ? null : result;
}
