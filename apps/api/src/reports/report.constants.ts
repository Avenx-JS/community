export const REPORT_REASONS = [
  'spam',
  'harassment',
  'hate_speech',
  'sexual_content',
  'self_harm',
  'impersonation',
  'other',
] as const;

export type ReportReason = (typeof REPORT_REASONS)[number];
export type ReportContextType = 'post' | 'comment';

export function isReportReason(value: unknown): value is ReportReason {
  return REPORT_REASONS.some((reason) => reason === value);
}
