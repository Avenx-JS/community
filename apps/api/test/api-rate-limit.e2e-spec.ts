import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from '@jest/globals';
import {
  CanActivate,
  Controller,
  ExecutionContext,
  Get,
  Injectable,
  Module,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import type { Request } from 'express';
import request from 'supertest';
import type { App } from 'supertest/types';
import { AuthRateLimitService } from '../src/auth/auth-rate-limit.service';
import { MYSQL_POOL } from '../src/auth/auth.service';
import { ApiRateLimitInterceptor } from '../src/common/api-rate-limit.interceptor';
import { configureHttpSecurity } from '../src/common/http-security';

interface TestRequest extends Request {
  user: { id: string };
}

@Injectable()
class TestIdentityGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<TestRequest>();
    const token = request.headers.authorization;
    if (token !== 'token-a' && token !== 'token-b') {
      return false;
    }
    request.user = { id: token === 'token-a' ? 'account-a' : 'account-b' };
    return true;
  }
}

@Controller()
class ApiRateLimitTestController {
  @Get('posts')
  listPosts() {
    return { items: [] };
  }

  @Get('posts/:postId/comments')
  getComments() {
    return { comments: [] };
  }

  @Get('health')
  health() {
    return { status: 'ok' };
  }

  @Post('posts')
  @UseGuards(TestIdentityGuard)
  createPost(@Req() request: TestRequest) {
    return { author_id: request.user.id };
  }
}

@Module({
  controllers: [ApiRateLimitTestController],
  providers: [TestIdentityGuard],
})
class ApiRateLimitTestModule {}

describe('API rate limits (e2e)', () => {
  let app: INestApplication<App>;
  let previousEnvironment: Record<string, string | undefined>;
  let buckets: Map<string, { count: number; windowStartedAt: number }>;

  beforeAll(() => {
    const names = [
      'API_REQUEST_IP_MAX',
      'API_READ_IP_MAX',
      'API_WRITE_IP_MAX',
      'API_WRITE_ACCOUNT_MAX',
      'API_CONTENT_CREATE_IP_MAX',
      'API_CONTENT_CREATE_ACCOUNT_MAX',
      'API_CONTENT_COOLDOWN_MAX',
      'API_CONTENT_COOLDOWN_WINDOW_SECONDS',
      'API_BODY_LIMIT_BYTES',
    ];
    previousEnvironment = Object.fromEntries(
      names.map((name) => [name, process.env[name]]),
    );
    process.env.API_REQUEST_IP_MAX = '100';
    process.env.API_READ_IP_MAX = '1';
    process.env.API_WRITE_IP_MAX = '100';
    process.env.API_WRITE_ACCOUNT_MAX = '100';
    process.env.API_CONTENT_CREATE_IP_MAX = '10';
    process.env.API_CONTENT_CREATE_ACCOUNT_MAX = '1';
    process.env.API_CONTENT_COOLDOWN_MAX = '1';
    process.env.API_CONTENT_COOLDOWN_WINDOW_SECONDS = '30';
    process.env.API_BODY_LIMIT_BYTES = '1024';
  });

  afterAll(() => {
    for (const [name, value] of Object.entries(previousEnvironment)) {
      if (value === undefined) {
        delete process.env[name];
      } else {
        process.env[name] = value;
      }
    }
  });

  beforeEach(async () => {
    buckets = new Map();
    const pool = {
      execute: (sql: string, values: unknown[]) => {
        const bucketKey = values[0] as string;
        const windowSeconds = Number(
          sql.match(/INTERVAL (\d+) SECOND/)?.[1] ?? 60,
        );
        const now = Math.floor(Date.now() / 1000);
        if (sql.startsWith('INSERT INTO auth_rate_limits')) {
          const current = buckets.get(bucketKey);
          if (!current || current.windowStartedAt + windowSeconds <= now) {
            buckets.set(bucketKey, { count: 1, windowStartedAt: now });
          } else {
            current.count += 1;
          }
          return Promise.resolve([{ affectedRows: 1 }, []] as [
            unknown,
            unknown,
          ]);
        }
        if (sql.startsWith('SELECT request_count')) {
          const bucket = buckets.get(bucketKey);
          return Promise.resolve([
            [
              {
                request_count: bucket?.count ?? 1,
                retry_after: Math.max(
                  1,
                  (bucket?.windowStartedAt ?? now) + windowSeconds - now,
                ),
              },
            ],
            [],
          ] as [unknown, unknown]);
        }
        return Promise.reject(new Error(`Unexpected limiter query: ${sql}`));
      },
    };

    const moduleFixture = await Test.createTestingModule({
      imports: [ApiRateLimitTestModule],
      providers: [
        AuthRateLimitService,
        { provide: MYSQL_POOL, useValue: pool },
      ],
    }).compile();
    app = moduleFixture.createNestApplication({ bodyParser: false });
    configureHttpSecurity(app, {
      NODE_ENV: 'test',
      CORS_ORIGINS: '',
      API_BODY_LIMIT_BYTES: process.env.API_BODY_LIMIT_BYTES,
    });
    app.useGlobalInterceptors(
      new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
    );
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('limits anonymous reads and returns Retry-After while exempting health', async () => {
    await request(app.getHttpServer()).get('/posts').expect(200);
    const limited = await request(app.getHttpServer())
      .get('/posts/post-1/comments')
      .expect(429);
    expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    await request(app.getHttpServer()).get('/health').expect(200);
    await request(app.getHttpServer()).get('/health').expect(200);
  });

  it('enforces authenticated creation limits by validated account identity', async () => {
    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'token-a')
      .send({ title: 'First' })
      .expect(201, { author_id: 'account-a' });

    await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'token-b')
      .send({ title: 'Other account' })
      .expect(201, { author_id: 'account-b' });

    const limited = await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'token-a')
      .send({ title: 'Too soon' })
      .expect(429);
    expect(limited.headers['retry-after']).toBeDefined();
  });

  it('applies body-size limits and returns protected error headers', async () => {
    const response = await request(app.getHttpServer())
      .post('/posts')
      .set('Authorization', 'token-a')
      .send({ content: 'x'.repeat(2048) })
      .expect(413, {
        statusCode: 413,
        message: 'Request body too large',
        error: 'Payload Too Large',
      });
    expect(response.headers['x-content-type-options']).toBe('nosniff');
  });
});
