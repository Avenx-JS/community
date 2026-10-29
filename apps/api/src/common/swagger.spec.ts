import 'reflect-metadata';
import { afterEach, beforeAll, describe, expect, it } from '@jest/globals';
import type { INestApplication } from '@nestjs/common';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DiscoveryModule, DiscoveryService } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import type { OpenAPIObject } from '@nestjs/swagger';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AppModule } from '../app.module';
import { AuthGuard } from '../auth/auth.guard';
import { MYSQL_POOL } from '../auth/auth.service';
import { configureHttpSecurity } from './http-security';
import {
  configureSwagger,
  createOpenApiDocument,
  isSwaggerEnabled,
  SWAGGER_CONTENT_SECURITY_POLICY,
} from './swagger';

// @nestjs/swagger exports only OpenAPIObject, so the nested types are derived.
type Schemas = NonNullable<NonNullable<OpenAPIObject['components']>['schemas']>;
type SchemaObject = Exclude<Schemas[string], { $ref: string }>;
type OperationObject = NonNullable<OpenAPIObject['paths'][string]['get']>;
type ParameterObject = Exclude<
  NonNullable<OperationObject['parameters']>[number],
  { $ref: string }
>;

function guardsOf(target: object): unknown[] {
  return (Reflect.getMetadata(GUARDS_METADATA, target) as unknown[]) ?? [];
}

async function createApp(): Promise<INestApplication<App>> {
  const moduleRef = await Test.createTestingModule({
    imports: [AppModule, DiscoveryModule],
  })
    .overrideProvider(MYSQL_POOL)
    .useValue({})
    .compile();
  return moduleRef.createNestApplication();
}

function operations(document: OpenAPIObject) {
  return Object.entries(document.paths).flatMap(([path, item]) =>
    (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((method) => {
      const operation = item[method];
      return operation ? [{ path, method, operation }] : [];
    }),
  );
}

function schema(document: OpenAPIObject, name: string): SchemaObject {
  const found = document.components?.schemas?.[name];
  if (!found || '$ref' in found) {
    throw new Error(`Missing schema ${name}`);
  }
  return found;
}

function property(
  document: OpenAPIObject,
  name: string,
  key: string,
): SchemaObject {
  return schema(document, name).properties?.[key] as SchemaObject;
}

function queryParameter(operation: OperationObject, name: string) {
  return (operation.parameters as ParameterObject[]).find(
    (parameter) => parameter.in === 'query' && parameter.name === name,
  );
}

describe('isSwaggerEnabled', () => {
  it.each([
    [{}, true],
    [{ NODE_ENV: 'development' }, true],
    [{ NODE_ENV: 'production' }, false],
    [{ NODE_ENV: 'production', SWAGGER_ENABLED: 'true' }, true],
    [{ NODE_ENV: 'development', SWAGGER_ENABLED: 'false' }, false],
  ])('%o -> %s', (env, expected) => {
    expect(isSwaggerEnabled(env)).toBe(expected);
  });

  it('rejects values other than true or false', () => {
    expect(() => isSwaggerEnabled({ SWAGGER_ENABLED: 'yes' })).toThrow(
      'SWAGGER_ENABLED must be true or false',
    );
  });
});

describe('OpenAPI document', () => {
  let document: OpenAPIObject;
  let routes: Array<{ operationId: string; guarded: boolean }>;

  beforeAll(async () => {
    const app = await createApp();
    await app.init();
    document = createOpenApiDocument(app);

    routes = app
      .get(DiscoveryService)
      .getControllers()
      .flatMap(({ metatype }) => {
        if (!metatype) {
          return [];
        }
        const controller = metatype as new (...args: never[]) => object;
        const classGuards = guardsOf(controller);
        const prototype = controller.prototype as Record<string, unknown>;
        return Object.getOwnPropertyNames(prototype)
          .filter(
            (name) =>
              name !== 'constructor' &&
              Reflect.hasMetadata(PATH_METADATA, prototype[name] as object),
          )
          .map((name) => {
            const methodGuards = guardsOf(prototype[name] as object);
            return {
              operationId: `${controller.name.replace(/Controller$/, '')}_${name}`,
              guarded: [...classGuards, ...methodGuards].includes(AuthGuard),
            };
          });
      });
    await app.close();
  });

  it('documents every controller route exactly once', () => {
    const documented = operations(document).map(
      ({ operation }) => operation.operationId,
    );

    expect(routes.length).toBeGreaterThan(30);
    expect([...documented].sort()).toEqual(
      routes.map(({ operationId }) => operationId).sort(),
    );
  });

  it('gives every operation a summary, a tag, and a typed success response', () => {
    for (const { path, method, operation } of operations(document)) {
      const label = `${method.toUpperCase()} ${path}`;
      expect([label, operation.summary]).toEqual([label, expect.any(String)]);
      expect([label, operation.tags?.length]).toEqual([
        label,
        expect.any(Number),
      ]);

      const success = Object.entries(operation.responses).filter(([status]) =>
        status.startsWith('2'),
      );
      expect([label, success.length]).toEqual([label, 1]);
      const [status, response] = success[0];
      if (status !== '204' && response && !('$ref' in response)) {
        expect([label, response.content]).toEqual([label, expect.anything()]);
      }
    }
  });

  it('marks exactly the AuthGuard routes as bearer-authenticated', () => {
    const byId = new Map(
      operations(document).map(({ operation }) => [
        operation.operationId,
        operation,
      ]),
    );

    for (const { operationId, guarded } of routes) {
      const operation = byId.get(operationId)!;
      const secured = (operation.security ?? []).some(
        (requirement) => 'bearer' in requirement,
      );
      expect([operationId, secured]).toEqual([operationId, guarded]);
      if (guarded) {
        expect([operationId, '401' in operation.responses]).toEqual([
          operationId,
          true,
        ]);
      }
    }
  });

  it('leaves no schema property as an untyped object', () => {
    for (const [name, model] of Object.entries(
      document.components?.schemas ?? {},
    )) {
      for (const [key, value] of Object.entries(
        (model as SchemaObject).properties ?? {},
      )) {
        const property = value as SchemaObject & { $ref?: string };
        const typed =
          property.$ref !== undefined ||
          property.allOf !== undefined ||
          property.oneOf !== undefined ||
          property.enum !== undefined ||
          (property.type !== undefined && property.type !== 'object') ||
          property.properties !== undefined ||
          property.additionalProperties !== undefined;
        expect([`${name}.${key}`, typed]).toEqual([`${name}.${key}`, true]);
      }
    }
  });

  it('carries validation rules from the DTOs', () => {
    expect(property(document, 'CreatePostDto', 'title')).toMatchObject({
      minLength: 1,
      maxLength: 300,
    });
    expect(property(document, 'CreatePostDto', 'type').enum).toEqual([
      'text',
      'link',
      'media',
    ]);
    expect(property(document, 'CreateVoteDto', 'value')).toMatchObject({
      type: 'integer',
      enum: [-1, 1],
    });
    expect(schema(document, 'CreateVoteDto').required).toEqual(
      expect.arrayContaining(['target_type', 'target_id', 'value']),
    );

    const listUsers = document.paths['/admin/users'].get!;
    expect(queryParameter(listUsers, 'page')).toMatchObject({
      required: false,
      schema: { type: 'integer', minimum: 1, maximum: 10000, default: 1 },
    });
    expect(queryParameter(listUsers, 'sort')).toMatchObject({
      required: false,
      schema: { default: 'new' },
    });
    expect(queryParameter(listUsers, 'from')).toMatchObject({
      required: false,
      schema: { format: 'date-time' },
    });

    for (const { path, operation } of operations(document)) {
      for (const name of ['page', 'limit']) {
        const parameter = queryParameter(operation, name);
        if (parameter) {
          expect([path, name, parameter.required, parameter.schema]).toEqual([
            path,
            name,
            false,
            expect.objectContaining({ type: 'integer' }),
          ]);
        }
      }
    }
  });

  it('declares every tag it uses', () => {
    const declared = (document.tags ?? []).map(({ name }) => name);
    const used = new Set(
      operations(document).flatMap(({ operation }) => operation.tags ?? []),
    );

    expect([...used].every((tag) => declared.includes(tag))).toBe(true);
    expect(declared).toHaveLength(used.size);
  });

  it('publishes route parameter patterns and the shared error responses', () => {
    const community = document.paths['/communities/{name}'].get!;
    expect(community.parameters).toContainEqual(
      expect.objectContaining({
        name: 'name',
        in: 'path',
        schema: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,50}$' },
      }),
    );
    expect(community.responses['404']).toMatchObject({
      content: {
        'application/json': {
          schema: { $ref: '#/components/schemas/ErrorResponse' },
        },
      },
    });
    expect(community.responses['429']).toMatchObject({
      headers: { 'Retry-After': expect.anything() },
    });
  });
});

describe('Swagger UI', () => {
  let app: INestApplication<App> | undefined;

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  async function start(env: NodeJS.ProcessEnv) {
    app = await createApp();
    configureHttpSecurity(app, env);
    configureSwagger(app, env);
    await app.init();
    return app.getHttpServer();
  }

  it('serves the UI and document with a docs-only content security policy', async () => {
    const server = await start({ NODE_ENV: 'development' });

    const page = await request(server).get('/docs').redirects(1).expect(200);
    expect(page.headers['content-security-policy']).toBe(
      SWAGGER_CONTENT_SECURITY_POLICY,
    );
    expect(page.text).not.toMatch(/<script>(?!\s*<\/script>)/);

    const json = await request(server).get('/docs/openapi.json').expect(200);
    expect(json.body).toMatchObject({
      openapi: expect.any(String),
      info: { title: 'Community API' },
    });

    const health = await request(server).get('/health').expect(200);
    expect(health.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(health.headers['content-security-policy']).not.toContain(
      'connect-src',
    );
  });

  it('is not served in production unless enabled', async () => {
    const server = await start({ NODE_ENV: 'production' });

    await request(server).get('/docs').expect(404);
    await request(server).get('/docs/openapi.json').expect(404);
  });
});
