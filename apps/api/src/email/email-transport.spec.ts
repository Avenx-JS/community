import 'reflect-metadata';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { Injectable, Logger, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  createEmailTransport,
  createSmtpClient,
  readEmailConfig,
  SmtpClientFactory,
} from './email-config';
import { EmailTransport, OutboundMessage } from './email-transport';
import { EmailModule } from './email.module';
import { LoggingEmailTransport } from './logging-email.transport';
import {
  EmailDeliveryError,
  SmtpClient,
  SmtpEmailTransport,
} from './smtp-email.transport';

const SMTP_PASSWORD = 'smtp-secret-password-value';
const BODY = 'Reset token: reset-token-value-that-must-stay-secret';
const MESSAGE: OutboundMessage = {
  to: 'member@example.com',
  subject: 'Reset your password',
  text: BODY,
};

const SMTP_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  EMAIL_TRANSPORT: 'smtp',
  SMTP_HOST: 'smtp.example.com',
  SMTP_FROM: 'noreply@example.com',
};

// Every Nest Logger method, so a test can assert on all logged output.
function spyOnLogger() {
  const methods = [
    'log',
    'error',
    'warn',
    'debug',
    'verbose',
    'fatal',
  ] as const;
  const spies = methods.map((method) =>
    jest.spyOn(Logger.prototype, method).mockImplementation(() => undefined),
  );
  return () =>
    spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)));
}

function stubClient(
  sendMail: SmtpClient['sendMail'] = () => Promise.resolve({}),
) {
  const client = { sendMail: jest.fn(sendMail) };
  return client;
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('readEmailConfig', () => {
  it.each([
    [{}],
    [{ NODE_ENV: 'development' }],
    [{ NODE_ENV: 'test' }],
    [{ NODE_ENV: 'development', EMAIL_TRANSPORT: '' }],
    [{ NODE_ENV: 'development', EMAIL_TRANSPORT: 'logging' }],
  ])('defaults to logging outside production: %j', (env) => {
    expect(readEmailConfig(env)).toEqual({ transport: 'logging' });
  });

  it.each([
    [
      { NODE_ENV: 'production' },
      'EMAIL_TRANSPORT must be configured in production',
    ],
    // An empty value must not select the development default.
    [
      { NODE_ENV: 'production', EMAIL_TRANSPORT: '' },
      'EMAIL_TRANSPORT must be configured in production',
    ],
    [
      { NODE_ENV: 'production', EMAIL_TRANSPORT: 'logging' },
      'EMAIL_TRANSPORT=logging cannot be used in production',
    ],
  ])('refuses production without a real transport: %j', (env, message) => {
    expect(() => readEmailConfig(env)).toThrow(message);
  });

  it.each(['console', 'SMTP', 'Logging', ' smtp', 'true'])(
    'rejects an unknown EMAIL_TRANSPORT: %s',
    (value) => {
      expect(() =>
        readEmailConfig({ NODE_ENV: 'development', EMAIL_TRANSPORT: value }),
      ).toThrow('EMAIL_TRANSPORT must be logging or smtp');
    },
  );

  it('reads SMTP with defaults for port, security and authentication', () => {
    expect(readEmailConfig(SMTP_ENV)).toEqual({
      transport: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        port: 587,
        secure: false,
        from: 'noreply@example.com',
      },
    });
  });

  it('reads every SMTP variable when configured', () => {
    expect(
      readEmailConfig({
        ...SMTP_ENV,
        SMTP_PORT: '2525',
        SMTP_SECURE: 'true',
        SMTP_USER: 'mailer',
        SMTP_PASSWORD,
      }),
    ).toEqual({
      transport: 'smtp',
      smtp: {
        host: 'smtp.example.com',
        port: 2525,
        secure: true,
        auth: { user: 'mailer', pass: SMTP_PASSWORD },
        from: 'noreply@example.com',
      },
    });
  });

  it('defaults the port to 465 for implicit TLS', () => {
    expect(readEmailConfig({ ...SMTP_ENV, SMTP_SECURE: 'true' })).toMatchObject(
      { smtp: { port: 465, secure: true } },
    );
  });

  it.each([
    ['SMTP_HOST', undefined],
    ['SMTP_HOST', ''],
    ['SMTP_FROM', undefined],
    ['SMTP_FROM', ''],
  ])('requires %s for smtp (value %j)', (name, value) => {
    expect(() => readEmailConfig({ ...SMTP_ENV, [name]: value })).toThrow(
      `${name} must be configured when EMAIL_TRANSPORT is smtp`,
    );
  });

  it.each([
    'noreply',
    'noreply@',
    '@example.com',
    'Community <noreply@example.com>',
  ])('rejects an SMTP_FROM that is not an email address: %s', (from) => {
    expect(() => readEmailConfig({ ...SMTP_ENV, SMTP_FROM: from })).toThrow(
      'SMTP_FROM must be an email address',
    );
  });

  it.each(['0', '-1', '65536', '25.5', 'smtp', '1e3x'])(
    'rejects an out-of-range or non-numeric SMTP_PORT: %s',
    (port) => {
      expect(() => readEmailConfig({ ...SMTP_ENV, SMTP_PORT: port })).toThrow(
        'SMTP_PORT must be an integer between 1 and 65535',
      );
    },
  );

  it.each(['yes', '1', 'TRUE'])('rejects SMTP_SECURE=%s', (secure) => {
    expect(() => readEmailConfig({ ...SMTP_ENV, SMTP_SECURE: secure })).toThrow(
      'SMTP_SECURE must be true or false',
    );
  });

  it.each([[{ SMTP_USER: 'mailer' }], [{ SMTP_PASSWORD }]])(
    'requires SMTP_USER and SMTP_PASSWORD together: %j',
    (credentials) => {
      expect(() => readEmailConfig({ ...SMTP_ENV, ...credentials })).toThrow(
        'SMTP_USER and SMTP_PASSWORD must be configured together',
      );
    },
  );

  it('never includes the SMTP password in a validation error', () => {
    const failures = [
      { SMTP_HOST: '' },
      { SMTP_FROM: 'invalid' },
      { SMTP_PORT: 'invalid' },
      { SMTP_SECURE: 'invalid' },
      { SMTP_USER: undefined },
    ].map((override) => {
      try {
        readEmailConfig({
          ...SMTP_ENV,
          SMTP_USER: 'mailer',
          SMTP_PASSWORD,
          ...override,
        });
        return '';
      } catch (error) {
        return (error as Error).message;
      }
    });

    expect(failures.every(Boolean)).toBe(true);
    for (const message of failures) {
      expect(message).not.toContain(SMTP_PASSWORD);
    }
  });
});

describe('createEmailTransport', () => {
  it('selects the logging transport outside production', () => {
    expect(createEmailTransport({ NODE_ENV: 'development' })).toBeInstanceOf(
      LoggingEmailTransport,
    );
  });

  it('selects SMTP and hands the client its connection settings', () => {
    const client = stubClient();
    const factory = jest.fn<SmtpClientFactory>(() => client);

    expect(
      createEmailTransport(
        { ...SMTP_ENV, SMTP_USER: 'mailer', SMTP_PASSWORD },
        factory,
      ),
    ).toBeInstanceOf(SmtpEmailTransport);
    expect(factory).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: SMTP_PASSWORD },
      from: 'noreply@example.com',
    });
  });

  it('does not create a client when configuration is invalid', () => {
    const factory = jest.fn<SmtpClientFactory>(() => stubClient());

    expect(() =>
      createEmailTransport({ ...SMTP_ENV, SMTP_HOST: undefined }, factory),
    ).toThrow('SMTP_HOST');
    expect(factory).not.toHaveBeenCalled();
  });

  it('builds the nodemailer client with its own logging disabled', () => {
    const client = createSmtpClient({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'mailer', pass: SMTP_PASSWORD },
      from: 'noreply@example.com',
    }) as SmtpClient & { options: Record<string, unknown> };

    expect(client.options).toMatchObject({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      logger: false,
      debug: false,
    });
  });
});

describe('LoggingEmailTransport', () => {
  it('resolves and logs recipient and subject', async () => {
    const logged = spyOnLogger();

    await expect(
      new LoggingEmailTransport({ NODE_ENV: 'development' }).send(MESSAGE),
    ).resolves.toBeUndefined();

    const output = logged().join('\n');
    expect(output).toContain('member@example.com');
    expect(output).toContain('Reset your password');
  });

  it('refuses construction in production even when selected directly', () => {
    expect(() => new LoggingEmailTransport({ NODE_ENV: 'production' })).toThrow(
      'The logging email transport cannot run in production',
    );
  });
});

describe('SmtpEmailTransport', () => {
  it('passes recipient, from-address, subject and text body to the client', async () => {
    const client = stubClient();

    await expect(
      new SmtpEmailTransport(client, 'noreply@example.com').send(MESSAGE),
    ).resolves.toBeUndefined();
    expect(client.sendMail).toHaveBeenCalledWith({
      from: 'noreply@example.com',
      to: 'member@example.com',
      subject: 'Reset your password',
      text: BODY,
    });
  });

  it('rejects when the client rejects, keeping only the error code', async () => {
    const failure = Object.assign(
      new Error(
        `535 Authentication failed for mailer:${SMTP_PASSWORD} ` +
          `<member@example.com> ${BODY}`,
      ),
      { code: 'EAUTH' },
    );
    const client = stubClient(() => Promise.reject(failure));

    const rejection = new SmtpEmailTransport(
      client,
      'noreply@example.com',
    ).send(MESSAGE);

    await expect(rejection).rejects.toBeInstanceOf(EmailDeliveryError);
    await expect(rejection).rejects.toMatchObject({
      code: 'EAUTH',
      message: 'Email delivery failed (EAUTH)',
    });
  });

  it('drops a client error code that does not look like a code', async () => {
    const client = stubClient(() =>
      Promise.reject(Object.assign(new Error('x'), { code: SMTP_PASSWORD })),
    );

    await expect(
      new SmtpEmailTransport(client, 'noreply@example.com').send(MESSAGE),
    ).rejects.toMatchObject({
      code: undefined,
      message: 'Email delivery failed',
    });
  });

  it('never logs the password or the body, on success or failure', async () => {
    const logged = spyOnLogger();
    const transport = createEmailTransport(
      { ...SMTP_ENV, SMTP_USER: 'mailer', SMTP_PASSWORD },
      () =>
        stubClient(() =>
          Promise.reject(
            Object.assign(new Error(`${SMTP_PASSWORD} ${BODY}`), {
              code: 'EAUTH',
            }),
          ),
        ),
    );
    const succeeding = new SmtpEmailTransport(
      stubClient(),
      'noreply@example.com',
    );

    await succeeding.send(MESSAGE);
    const error = await transport.send(MESSAGE).catch((e: unknown) => e);

    const output = [...logged(), String(error), JSON.stringify(error)].join(
      '\n',
    );
    expect(output).not.toContain(SMTP_PASSWORD);
    expect(output).not.toContain(BODY);
  });
});

describe('EmailModule', () => {
  const keys = [
    'NODE_ENV',
    'EMAIL_TRANSPORT',
    'SMTP_HOST',
    'SMTP_FROM',
  ] as const;
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );

  beforeEach(() => {
    for (const key of keys) {
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of keys) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  });

  @Injectable()
  class Consumer {
    constructor(readonly email: EmailTransport) {}
  }

  @Module({ imports: [EmailModule], providers: [Consumer] })
  class FeatureModule {}

  it('lets a feature module inject EmailTransport without configuration', async () => {
    process.env.NODE_ENV = 'development';
    const moduleRef = await Test.createTestingModule({
      imports: [FeatureModule],
    }).compile();

    expect(moduleRef.get(Consumer).email).toBeInstanceOf(LoggingEmailTransport);
  });

  it.each([{}, { EMAIL_TRANSPORT: 'logging' }, { EMAIL_TRANSPORT: '' }])(
    'fails to compile in production without a real transport: %j',
    async (env) => {
      process.env.NODE_ENV = 'production';
      Object.assign(process.env, env);

      await expect(
        Test.createTestingModule({ imports: [FeatureModule] }).compile(),
      ).rejects.toThrow(/EMAIL_TRANSPORT/);
    },
  );

  it('compiles in production with a valid SMTP configuration', async () => {
    Object.assign(process.env, SMTP_ENV);

    const moduleRef = await Test.createTestingModule({
      imports: [FeatureModule],
    }).compile();

    expect(moduleRef.get(Consumer).email).toBeInstanceOf(SmtpEmailTransport);
  });
});
