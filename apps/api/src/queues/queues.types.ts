import type { OutboundMessage } from '../email/email-transport';

export const EMAIL_QUEUE_NAME = 'avenx-email-queue';
export const DATA_EXPORT_QUEUE_NAME = 'avenx-data-export-queue';
export const MAINTENANCE_QUEUE_NAME = 'avenx-maintenance-queue';

export type EmailJobData = OutboundMessage;

export interface DataExportJobData {
  exportId: string;
  userId: string;
}

