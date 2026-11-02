import { EmailTransport, OutboundMessage } from './email-transport';

export interface SmtpClient {
  sendMail(mail: {
    from: string;
    to: string;
    subject: string;
    text: string;
  }): Promise<unknown>;
}

// Carries only the client's error code (for example EAUTH or ECONNECTION).
// Client error messages can echo server responses that contain addresses or
// credentials, so they are not copied into the rejection.
export class EmailDeliveryError extends Error {
  constructor(readonly code: string | undefined) {
    super(`Email delivery failed${code ? ` (${code})` : ''}`);
    this.name = 'EmailDeliveryError';
  }
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^[A-Z][A-Z0-9_]{0,31}$/.test(code)
    ? code
    : undefined;
}

// Logs nothing: recipient and subject are the caller's to log, and the body,
// which may contain a reset token, is never logged.
export class SmtpEmailTransport extends EmailTransport {
  constructor(
    private readonly client: SmtpClient,
    private readonly from: string,
  ) {
    super();
  }

  async send(message: OutboundMessage): Promise<void> {
    try {
      await this.client.sendMail({
        from: this.from,
        to: message.to,
        subject: message.subject,
        text: message.text,
      });
    } catch (error) {
      throw new EmailDeliveryError(errorCode(error));
    }
  }
}
