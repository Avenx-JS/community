export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'self_harm',
  'impersonation',
  'other',
] as const;

export const REPORT_STATUSES = [
  'open',
  'under_review',
  'resolved',
  'rejected',
] as const;

export const REPORT_RESOLUTIONS = [
  'no_action',
  'content_removed',
  'user_warned',
  'user_suspended',
  'user_banned',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportStatus = (typeof REPORT_STATUSES)[number];
export type ReportResolution = (typeof REPORT_RESOLUTIONS)[number];
export type ReportContextType = 'post' | 'comment';
// What a report is about (user_reports.target_type). POST /reports writes
// only 'user' targets.
export type ReportTargetType = 'user' | 'post' | 'comment' | 'community';

export function isReportReason(value: unknown): value is ReportReason {
  return REPORT_REASONS.some((reason) => reason === value);
}
