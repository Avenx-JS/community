import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { AuthRateLimitService } from './auth/auth-rate-limit.service';
import { AppModule } from './app.module';
import { ApiRateLimitInterceptor } from './common/api-rate-limit.interceptor';
import { configureHttpSecurity } from './common/http-security';
import { SafeApiExceptionFilter } from './common/safe-api-exception.filter';
import { configureSwagger } from './common/swagger';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { bodyParser: false });
  configureHttpSecurity(app);
  app.useGlobalFilters(new SafeApiExceptionFilter(app.get(HttpAdapterHost)));
  app.useGlobalInterceptors(
    new ApiRateLimitInterceptor(app.get(AuthRateLimitService)),
  );
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  configureSwagger(app);
  await app.listen(process.env.PORT ?? 3000);
}
void bootstrap();
