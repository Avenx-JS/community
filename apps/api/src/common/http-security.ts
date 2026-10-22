import type { INestApplication } from '@nestjs/common';
import type { CustomOrigin } from '@nestjs/common/interfaces/external/cors-options.interface';
import type { Express, NextFunction, Request, Response } from 'express';
import express from 'express';
import helmet from 'helmet';

const DEVELOPMENT_ORIGINS = ['http://localhost:4200', 'http://127.0.0.1:4200'];

function parseAllowedOrigins(env: NodeJS.ProcessEnv): string[] {
  const configured = env.CORS_ORIGINS;
  const origins =
    configured === undefined
      ? env.NODE_ENV === 'production'
        ? []
        : DEVELOPMENT_ORIGINS
      : configured
          .split(',')
          .map((origin) => origin.trim())
          .filter(Boolean);

  return origins.map((origin) => {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }

    if (
      origin === '*' ||
      !['http:', 'https:'].includes(parsed.protocol) ||
      parsed.origin !== origin ||
      parsed.username ||
      parsed.password
    ) {
      throw new Error(`Invalid CORS origin: ${origin}`);
    }
    return parsed.origin;
  });
}

function parseTrustedProxyHops(env: NodeJS.ProcessEnv): number {
  const configured = env.TRUST_PROXY_HOPS;
  if (configured === undefined || configured === '') {
    return 0;
  }
  if (!/^(0|[1-9]\d*)$/.test(configured)) {
    throw new Error('TRUST_PROXY_HOPS must be a non-negative integer');
  }

  const hops = Number(configured);
  if (!Number.isSafeInteger(hops) || hops > 10) {
    throw new Error('TRUST_PROXY_HOPS must be between 0 and 10');
  }
  return hops;
}

function parseBodyLimitBytes(env: NodeJS.ProcessEnv): number {
  const configured = env.API_BODY_LIMIT_BYTES;
  if (configured === undefined) {
    return 65_536;
  }

  if (!/^[1-9]\d*$/.test(configured)) {
    throw new Error('API_BODY_LIMIT_BYTES must be a positive integer');
  }
  const limit = Number(configured);
  if (!Number.isSafeInteger(limit) || limit < 1024 || limit > 1_048_576) {
    throw new Error('API_BODY_LIMIT_BYTES must be between 1024 and 1048576');
  }
  return limit;
}

export function configureHttpSecurity(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const allowedOrigins = parseAllowedOrigins(env);
  const trustedProxyHops = parseTrustedProxyHops(env);
  const bodyLimitBytes = parseBodyLimitBytes(env);
  const production = env.NODE_ENV === 'production';
  const expressApp = app.getHttpAdapter().getInstance() as Express;
  const allowOrigin: CustomOrigin = (origin, callback) => {
    if (origin && allowedOrigins.includes(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  };

  expressApp.set('trust proxy', trustedProxyHops);

  expressApp.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          baseUri: ["'none'"],
          defaultSrc: ["'none'"],
          frameAncestors: ["'none'"],
        },
      },
      referrerPolicy: { policy: 'no-referrer' },
      strictTransportSecurity: false,
      xContentTypeOptions: true,
      xFrameOptions: { action: 'deny' },
    }),
  );

  if (production) {
    const hsts = helmet.hsts({
      maxAge: 31_536_000,
      includeSubDomains: true,
    });
    expressApp.use(
      (request: Request, response: Response, next: NextFunction) => {
        if (request.secure) {
          hsts(request, response, next);
          return;
        }
        next();
      },
    );
  }

  app.enableCors({
    origin: allowOrigin,
    credentials: false,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type'],
    maxAge: 600,
    optionsSuccessStatus: 204,
  });
  const jsonParser = express.json({ limit: bodyLimitBytes });
  expressApp.use((request, response, next) => {
    jsonParser(request, response, (error?: Error & { status?: number }) => {
      if (error?.status === 413) {
        response.status(413).json({
          statusCode: 413,
          message: 'Request body too large',
          error: 'Payload Too Large',
        });
        return;
      }
      next(error);
    });
  });
}
