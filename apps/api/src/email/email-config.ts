import { isEmail } from 'class-validator';
import { createTransport } from 'nodemailer';
import { EmailTransport } from './email-transport';
import { LoggingEmailTransport } from './logging-email.transport';
import { SmtpClient, SmtpEmailTransport } from './smtp-email.transport';

export interface SmtpConfig {
  host: string;
  port: number;
  secure: boolean;
  auth?: { user: string; pass: string };
  from: string;
}

export type EmailConfig =
  { transport: 'logging' } | { transport: 'smtp'; smtp: SmtpConfig };

// Error messages name the variable and its rule, never the configured value,
// so SMTP_PASSWORD cannot reach a startup log through a validation failure.
function readOptional(env: NodeJS.ProcessEnv, name: string) {
  const value = env[name];
  return value === undefined || value === '' ? undefined : value;
}

function readRequired(env: NodeJS.ProcessEnv, name: string): string {
  const value = readOptional(env, name);
  if (value === undefined) {
    throw new Error(`${name} must be configured when EMAIL_TRANSPORT is smtp`);
  }
  return value;
}

function readSecure(env: NodeJS.ProcessEnv): boolean {
  const configured = readOptional(env, 'SMTP_SECURE');
  if (configured === undefined) {
    return false;
  }
  if (configured !== 'true' && configured !== 'false') {
    throw new Error('SMTP_SECURE must be true or false');
  }
  return configured === 'true';
}

function readPort(env: NodeJS.ProcessEnv, fallback: number): number {
  const configured = readOptional(env, 'SMTP_PORT');
  if (configured === undefined) {
    return fallback;
  }

  const value = Number(configured);
  if (!Number.isSafeInteger(value) || value < 1 || value > 65535) {
    throw new Error('SMTP_PORT must be an integer between 1 and 65535');
  }
  return value;
}

function readSmtpConfig(env: NodeJS.ProcessEnv): SmtpConfig {
  const host = readRequired(env, 'SMTP_HOST');
  const from = readRequired(env, 'SMTP_FROM');
  if (!isEmail(from)) {
    throw new Error('SMTP_FROM must be an email address');
  }

  const secure = readSecure(env);
  const port = readPort(env, secure ? 465 : 587);
  const user = readOptional(env, 'SMTP_USER');
  const pass = readOptional(env, 'SMTP_PASSWORD');
  if (user === undefined || pass === undefined) {
    if (user !== pass) {
      throw new Error(
        'SMTP_USER and SMTP_PASSWORD must be configured together',
      );
    }
    return { host, port, secure, from };
  }
  return { host, port, secure, auth: { user, pass }, from };
}

export function readEmailConfig(env: NodeJS.ProcessEnv): EmailConfig {
  const production = env.NODE_ENV === 'production';
  const configured = env.EMAIL_TRANSPORT;

  // An empty value counts as unset, so it cannot select the development
  // default in production.
  if (configured === undefined || configured === '') {
    if (production) {
      throw new Error('EMAIL_TRANSPORT must be configured in production');
    }
    return { transport: 'logging' };
  }
  if (configured !== 'logging' && configured !== 'smtp') {
    throw new Error('EMAIL_TRANSPORT must be logging or smtp');
  }
  if (configured === 'logging') {
    if (production) {
      throw new Error('EMAIL_TRANSPORT=logging cannot be used in production');
    }
    return { transport: 'logging' };
  }
  return { transport: 'smtp', smtp: readSmtpConfig(env) };
}

export type SmtpClientFactory = (config: SmtpConfig) => SmtpClient;

// nodemailer's logger stays off: its debug output records the SMTP
// conversation, which carries the message body and the AUTH exchange.
export const createSmtpClient: SmtpClientFactory = ({
  host,
  port,
  secure,
  auth,
}) =>
  createTransport({ host, port, secure, auth, logger: false, debug: false });

export function createEmailTransport(
  env: NodeJS.ProcessEnv = process.env,
  createClient: SmtpClientFactory = createSmtpClient,
): EmailTransport {
  const config = readEmailConfig(env);
  if (config.transport === 'logging') {
    return new LoggingEmailTransport(env);
  }
  return new SmtpEmailTransport(createClient(config.smtp), config.smtp.from);
}
