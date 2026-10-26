export const ACTIVE_USER_RESTRICTION_PREDICATE =
  'lifted_at IS NULL AND (expires_at IS NULL OR expires_at > UTC_TIMESTAMP())';
