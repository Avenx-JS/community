// Left joins throughout: user_reports.target_id has no foreign key, so a report
// outlives its target, and a community report has no reported account.
// Qualifying each join by type means a report only looks up its own kind of
// target. Shared by the admin queue and the reporter's own listing; each picks
// its label from these joins with its own CASE.
export const REPORT_TARGET_JOINS_SQL = `LEFT JOIN users target_user
         ON ur.target_type = 'user' AND target_user.id = ur.target_id
       LEFT JOIN posts target_post
         ON ur.target_type = 'post' AND target_post.id = ur.target_id
       LEFT JOIN comments target_comment
         ON ur.target_type = 'comment' AND target_comment.id = ur.target_id
       LEFT JOIN communities target_community
         ON ur.target_type = 'community' AND target_community.id = ur.target_id`;
