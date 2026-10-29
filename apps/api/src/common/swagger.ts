import type { INestApplication } from '@nestjs/common';
import {
  DocumentBuilder,
  SwaggerModule,
  type OpenAPIObject,
} from '@nestjs/swagger';
import type { Express, NextFunction, Request, Response } from 'express';
import { ErrorResponse } from './openapi';

export const SWAGGER_PATH = 'docs';

// The API's helmet policy has no connect-src, which would block "Try it out"
// requests, and upgrades requests to HTTPS. Swagger UI pages get their own
// policy: same-origin scripts and API calls, plus the UI's inline styles.
export const SWAGGER_CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "base-uri 'none'",
  "connect-src 'self'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "img-src 'self' data:",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
].join('; ');

export function isSwaggerEnabled(env: NodeJS.ProcessEnv): boolean {
  const configured = env.SWAGGER_ENABLED;
  if (configured === undefined || configured === '') {
    return env.NODE_ENV !== 'production';
  }
  if (configured !== 'true' && configured !== 'false') {
    throw new Error('SWAGGER_ENABLED must be true or false');
  }
  return configured === 'true';
}

export function createOpenApiDocument(app: INestApplication): OpenAPIObject {
  const config = new DocumentBuilder()
    .setTitle('Community API')
    .setDescription(
      'REST API for communities, posts, comments, votes, reports, and ' +
        'platform administration. Error responses share the `ErrorResponse` ' +
        'shape; every route except `GET /health` is rate limited.',
    )
    .addTag('health', 'Service status.')
    .addTag('auth', 'Registration, login, token rotation, and logout.')
    .addTag('users', 'Public user profiles.')
    .addTag('communities', 'Communities, subscriptions, and moderators.')
    .addTag('subscriptions', "The authenticated user's memberships.")
    .addTag('posts', 'Posts within communities.')
    .addTag('comments', 'Threaded comments on posts.')
    .addTag('votes', 'Votes on posts and comments.')
    .addTag('reports', 'Reporting users to platform administrators.')
    .addTag('admin: users', 'Account directory for administrators.')
    .addTag('admin: reports', 'Report review queue.')
    .addTag('admin: restrictions', 'Suspensions and bans.')
    .addTag('admin: audit log', 'Append-only record of administrative actions.')
    .addTag('admin: analytics', 'Aggregate platform metrics.')
    .addBearerAuth({
      type: 'http',
      scheme: 'bearer',
      description:
        'Opaque access token from `POST /auth/login`, `POST /auth/register`, ' +
        'or `POST /auth/refresh`.',
    })
    .addGlobalResponse({
      status: 429,
      description: 'Rate limit exceeded; retry after the indicated delay.',
      type: ErrorResponse,
      headers: {
        'Retry-After': {
          description: 'Seconds to wait before retrying.',
          schema: { type: 'integer' },
        },
      },
    })
    .build();

  return SwaggerModule.createDocument(app, config, {
    operationIdFactory: (controllerKey, methodKey) =>
      `${controllerKey.replace(/Controller$/, '')}_${methodKey}`,
  });
}

export function configureSwagger(
  app: INestApplication,
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!isSwaggerEnabled(env)) {
    return;
  }

  const expressApp = app.getHttpAdapter().getInstance() as Express;
  expressApp.use(
    `/${SWAGGER_PATH}`,
    (_request: Request, response: Response, next: NextFunction) => {
      response.setHeader(
        'Content-Security-Policy',
        SWAGGER_CONTENT_SECURITY_POLICY,
      );
      next();
    },
  );

  SwaggerModule.setup(SWAGGER_PATH, app, () => createOpenApiDocument(app), {
    jsonDocumentUrl: `${SWAGGER_PATH}/openapi.json`,
    yamlDocumentUrl: `${SWAGGER_PATH}/openapi.yaml`,
    customSiteTitle: 'Community API',
    swaggerOptions: { persistAuthorization: false },
  });
}
