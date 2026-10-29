// The contract every community-activity notification producer must honour:
// membership defines the delivery scope, and a missing preference row means
// new_posts = TRUE. Producers may add conditions (such as excluding the
// author) but must not drop these. Documented verbatim in apps/api/README.md.
export const COMMUNITY_NEW_POST_RECIPIENTS_SQL = `SELECT s.user_id
FROM community_subscriptions s
LEFT JOIN community_notification_preferences p
       ON p.user_id = s.user_id AND p.community_id = s.community_id
WHERE s.community_id = ? AND COALESCE(p.new_posts, TRUE) = TRUE`;
