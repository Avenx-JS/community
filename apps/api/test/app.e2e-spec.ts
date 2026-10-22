import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { configureHttpSecurity } from '../src/common/http-security';

describe('AppController (e2e)', () => {
  let app: INestApplication<App>;

  beforeEach(async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = moduleFixture.createNestApplication();
    configureHttpSecurity(app, {
      NODE_ENV: 'test',
      CORS_ORIGINS: 'http://localhost:4200',
    });
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('serves allowed origins with security headers', async () => {
    const response = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'http://localhost:4200')
      .expect(200)
      .expect('Hello World!');

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
    expect(response.headers['x-content-type-options']).toBe('nosniff');
    expect(response.headers['x-frame-options']).toBe('DENY');
    expect(response.headers['referrer-policy']).toBe('no-referrer');
    expect(response.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
    expect(response.headers['strict-transport-security']).toBeUndefined();
  });

  it('does not allow unconfigured origins and applies headers to errors', async () => {
    const deniedOrigin = await request(app.getHttpServer())
      .get('/')
      .set('Origin', 'https://untrusted.example')
      .expect(200);
    expect(deniedOrigin.headers['access-control-allow-origin']).toBeUndefined();

    const deniedPreflight = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'https://untrusted.example')
      .set('Access-Control-Request-Method', 'POST')
      .expect(404);
    expect(
      deniedPreflight.headers['access-control-allow-origin'],
    ).toBeUndefined();

    const notFound = await request(app.getHttpServer())
      .get('/not-found')
      .expect(404);
    expect(notFound.headers['x-content-type-options']).toBe('nosniff');
    expect(notFound.headers['x-frame-options']).toBe('DENY');
    expect(notFound.headers['referrer-policy']).toBe('no-referrer');
    expect(notFound.headers['content-security-policy']).toContain(
      "default-src 'none'",
    );
  });

  it('answers allowed preflight requests without enabling credentials', async () => {
    const response = await request(app.getHttpServer())
      .options('/')
      .set('Origin', 'http://localhost:4200')
      .set('Access-Control-Request-Method', 'POST')
      .set('Access-Control-Request-Headers', 'authorization,content-type')
      .expect(204);

    expect(response.headers['access-control-allow-origin']).toBe(
      'http://localhost:4200',
    );
    expect(response.headers['access-control-allow-methods']).toContain('POST');
    expect(response.headers['access-control-allow-headers']).toContain(
      'Authorization',
    );
    expect(
      response.headers['access-control-allow-credentials'],
    ).toBeUndefined();
  });

  it('sets HSTS only for HTTPS requests in production with a trusted proxy', async () => {
    const moduleFixture: TestingModule = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    const productionApp: INestApplication<App> =
      moduleFixture.createNestApplication();
    configureHttpSecurity(productionApp, {
      NODE_ENV: 'production',
      CORS_ORIGINS: '',
      TRUST_PROXY_HOPS: '1',
    });
    await productionApp.init();

    try {
      const httpResponse = await request(productionApp.getHttpServer())
        .get('/')
        .expect(200);
      expect(httpResponse.headers['strict-transport-security']).toBeUndefined();

      const httpsResponse = await request(productionApp.getHttpServer())
        .get('/')
        .set('X-Forwarded-Proto', 'https')
        .expect(200);
      expect(httpsResponse.headers['strict-transport-security']).toContain(
        'max-age=31536000',
      );
      expect(
        httpsResponse.headers['access-control-allow-origin'],
      ).toBeUndefined();
    } finally {
      await productionApp.close();
    }
  });
});
