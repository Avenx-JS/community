import { Logger } from '@nestjs/common';
import { EmailTransport, OutboundMessage } from './email-transport';

// Development-only: the body is logged so flows such as password reset can be
// exercised locally, which is exactly why this transport refuses production.
// The body may contain a reset token and must never reach a production log.
export class LoggingEmailTransport extends EmailTransport {
  private readonly logger = new Logger(LoggingEmailTransport.name);

  constructor(env: NodeJS.ProcessEnv = process.env) {
    super();
    if (env.NODE_ENV === 'production') {
      throw new Error('The logging email transport cannot run in production');
    }
  }

  send(message: OutboundMessage): Promise<void> {
    this.logger.log(
      `Email to ${message.to}, subject: ${message.subject}\n${message.text}`,
    );
    return Promise.resolve();
  }
}
