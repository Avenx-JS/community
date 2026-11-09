-- Adds reporter withdrawal to user_reports, for DELETE /reports/:id.
-- withdrawn_at IS NULL means "the reporter stands behind this report"; a value
-- records when the reporter withdrew it. Withdrawal is a state change, never a
-- row deletion: user_restrictions.report_id and the admin_actions audit trail
-- refer to report rows, and a reporter must not erase a record a moderator has
-- acted on.
-- A separate column rather than a new status value: status is the moderator's
-- workflow (UpdateReportStatusDto and the transition rules in
-- AdminReportsService.updateStatus), and a value the reporter could set would
-- entangle two state machines. Only an open report can be withdrawn, so a
-- withdrawn report always has status 'open'.
-- NULL for every existing report, so no report reads as withdrawn and nothing in
-- the queue changes until a reporter withdraws one. No index: withdrawal is
-- rare, and every reader already narrows by status, reporter or target first.
--
-- Not safely re-runnable after partial application: ADD COLUMN fails if the
-- column exists. After a failure, check SHOW CREATE TABLE user_reports for
-- withdrawn_at before recording this version.
ALTER TABLE user_reports
  ADD COLUMN withdrawn_at TIMESTAMP NULL DEFAULT NULL;
