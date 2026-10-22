import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from './auth.guard';
import type { AuthenticatedRequest } from './auth.guard';
import { AuthService } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';

@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authRateLimitService: AuthRateLimitService,
  ) {}

  @Post('register')
  async register(
    @Body() body: RegisterDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.enforceRateLimit(
      response,
      this.authRateLimitService.enforceRegistration(
        this.clientIp(request),
        body.username,
        body.email,
      ),
    );
    return this.authService.register(body);
  }

  @Post('login')
  @HttpCode(HttpStatus.OK)
  async login(
    @Body() body: LoginDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.enforceRateLimit(
      response,
      this.authRateLimitService.enforceLogin(
        this.clientIp(request),
        body.identifier,
      ),
    );
    return this.authService.login(body);
  }

  @Post('refresh')
  @HttpCode(HttpStatus.OK)
  async refresh(
    @Body() body: RefreshDto,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.enforceRateLimit(
      response,
      this.authRateLimitService.enforceRefresh(
        this.clientIp(request),
        body.refreshToken,
      ),
    );
    return this.authService.refresh(body.refreshToken);
  }

  @Post('logout')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.authService.logout(request.accessToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  async logoutAll(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.authService.logoutAll(request.user.id);
  }

  private clientIp(request: Request): string {
    return request.ip ?? request.socket.remoteAddress ?? 'unknown';
  }

  private async enforceRateLimit(
    response: Response,
    check: Promise<number | null>,
  ): Promise<void> {
    const retryAfter = await check;
    if (retryAfter !== null) {
      response.setHeader('Retry-After', String(retryAfter));
      throw new HttpException(
        'Too many requests',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
  }
}
