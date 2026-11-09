// The CHECK-style rules that are enforced by triggers instead of CHECK
// constraints. MySQL 8 refuses a CHECK constraint that names a column whose
// foreign key has a referential action that writes it (ON DELETE SET NULL, or
// ON UPDATE CASCADE or SET NULL, error 3823; ON DELETE CASCADE is accepted), and
// every rule here names such a column. Each rule is a BEFORE
// INSERT and a BEFORE UPDATE trigger that raises the CHECK error itself
// (3819, ER_CHECK_CONSTRAINT_VIOLATED, with MySQL's own message), so callers
// see exactly what a CHECK constraint would produce.
//
// `IF NOT (expression)` keeps CHECK semantics: a CHECK fails only when its
// expression is FALSE, and IF does not run its branch for UNKNOWN (NULL).
//
// The migrations and data/community.sql contain the rendered blocks
// verbatim; check-trigger-rules.spec.ts keeps all three in step.
export interface CheckTriggerRule {
  name: string;
  table: string;
  migration: string;
  // The CHECK expression with every column written as NEW.<column>.
  expression: string;
}

export const CHECK_TRIGGER_RULES: readonly CheckTriggerRule[] = [
  {
    name: 'chk_user_reports_not_self',
    table: 'user_reports',
    migration: '002_create_user_reports',
    expression:
      'NEW.reporter_id IS NULL OR NEW.reporter_id <> NEW.reported_user_id',
  },
  {
    name: 'chk_user_restrictions_lift',
    table: 'user_restrictions',
    migration: '003_create_user_restrictions',
    expression:
      '(NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL',
  },
  {
    name: 'chk_posts_lock',
    table: 'posts',
    migration: '017_add_post_and_comment_content_state',
    expression:
      '(NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL',
  },
  {
    name: 'chk_posts_removal',
    table: 'posts',
    migration: '017_add_post_and_comment_content_state',
    expression:
      '(NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL',
  },
  {
    name: 'chk_comments_lock',
    table: 'comments',
    migration: '017_add_post_and_comment_content_state',
    expression:
      '(NEW.locked_at IS NULL AND NEW.locked_by IS NULL) OR NEW.locked_at IS NOT NULL',
  },
  {
    name: 'chk_comments_removal',
    table: 'comments',
    migration: '017_add_post_and_comment_content_state',
    expression:
      '(NEW.removed_at IS NULL AND NEW.removed_by IS NULL AND NEW.removal_reason IS NULL) OR NEW.removed_at IS NOT NULL',
  },
  {
    name: 'chk_communities_deletion',
    table: 'communities',
    migration: '022_add_community_deletion',
    expression:
      '(NEW.deleted_at IS NULL AND NEW.deleted_by IS NULL) OR NEW.deleted_at IS NOT NULL',
  },
  {
    name: 'chk_communities_suspension',
    table: 'communities',
    migration: '025_add_community_suspension',
    expression:
      '(NEW.suspended_at IS NULL AND NEW.suspended_by IS NULL AND NEW.suspension_reason IS NULL) OR NEW.suspended_at IS NOT NULL',
  },
  {
    name: 'chk_posts_pin',
    table: 'posts',
    migration: '026_add_post_pinning',
    expression:
      '(NEW.pinned_at IS NULL AND NEW.pinned_by IS NULL) OR NEW.pinned_at IS NOT NULL',
  },
  {
    name: 'chk_user_reports_assignment',
    table: 'user_reports',
    migration: '031_add_report_assignment',
    expression:
      '(NEW.assigned_to IS NULL AND NEW.assigned_at IS NULL) OR NEW.assigned_at IS NOT NULL',
  },
  {
    name: 'chk_community_bans_lift',
    table: 'community_bans',
    migration: '032_create_community_bans',
    expression:
      '(NEW.lifted_at IS NULL AND NEW.lifted_by IS NULL AND NEW.lift_reason IS NULL) OR NEW.lifted_at IS NOT NULL',
  },
];

export function checkTriggerRule(name: string): CheckTriggerRule {
  const rule = CHECK_TRIGGER_RULES.find((entry) => entry.name === name);
  if (!rule) {
    throw new Error(`Unknown check trigger rule ${name}`);
  }
  return rule;
}

// The exact block, marker comment to DELIMITER ;, as the SQL files hold it.
export function checkTriggerSql(rule: CheckTriggerRule): string {
  const base = rule.name.replace(/^chk_/, 'trg_');
  const trigger = (event: 'INSERT' | 'UPDATE') =>
    [
      `CREATE TRIGGER ${base}_${event.toLowerCase()} BEFORE ${event} ON ${rule.table} FOR EACH ROW`,
      'BEGIN',
      `  IF NOT (${rule.expression}) THEN`,
      "    SIGNAL SQLSTATE 'HY000'",
      `      SET MYSQL_ERRNO = 3819, MESSAGE_TEXT = 'Check constraint ''${rule.name}'' is violated.';`,
      '  END IF;',
      'END$$',
    ].join('\n');
  return [
    `-- ${rule.name} (${rule.migration}): enforced by triggers, see the README.`,
    'DELIMITER $$',
    trigger('INSERT'),
    trigger('UPDATE'),
    'DELIMITER ;',
  ].join('\n');
}
