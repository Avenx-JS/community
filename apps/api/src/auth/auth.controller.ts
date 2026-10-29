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
import {
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { Request, Response } from 'express';
import {
  ApiAuthenticated,
  ApiErrorResponses,
  ErrorResponse,
  RestrictedAccountResponse,
} from '../common/openapi';
import { AuthTokensResponse } from './auth.responses';
import { AuthGuard } from './auth.guard';
import type { AuthenticatedRequest } from './auth.guard';
import { AllowRestricted } from './allow-restricted.decorator';
import { AuthService } from './auth.service';
import { AuthRateLimitService } from './auth-rate-limit.service';
import { LoginDto } from './dto/login.dto';
import { RegisterDto } from './dto/register.dto';
import { RefreshDto } from './dto/refresh.dto';

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly authService: AuthService,
    private readonly authRateLimitService: AuthRateLimitService,
  ) {}

  @Post('register')
  @ApiOperation({
    summary: 'Register an account',
    description: 'Rate limited per client IP, username, and email.',
  })
  @ApiCreatedResponse({ type: AuthTokensResponse })
  @ApiErrorResponses({
    400: 'Invalid registration data.',
    409: 'Registration could not be completed.',
  })
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
  @ApiOperation({
    summary: 'Log in',
    description:
      'Accepts a username or email as identifier. Rate limited per client ' +
      'IP and identifier.',
  })
  @ApiOkResponse({ type: AuthTokensResponse })
  @ApiErrorResponses({ 400: 'Invalid login data.' })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'Invalid credentials.',
  })
  @ApiForbiddenResponse({
    type: RestrictedAccountResponse,
    description: 'The account is suspended or banned.',
  })
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
  @ApiOperation({
    summary: 'Rotate tokens',
    description:
      'Exchanges a refresh token for a new token pair. Each refresh token ' +
      'is single-use; presenting a used one revokes the whole session.',
  })
  @ApiOkResponse({ type: AuthTokensResponse })
  @ApiErrorResponses({ 400: 'Invalid refresh token format.' })
  @ApiUnauthorizedResponse({
    type: ErrorResponse,
    description: 'Invalid, expired, or reused refresh token.',
  })
  @ApiForbiddenResponse({
    type: RestrictedAccountResponse,
    description: 'The account is suspended or banned.',
  })
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
  @AllowRestricted()
  @ApiOperation({
    summary: 'Log out this session',
    description: 'Also available to suspended and banned accounts.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiNoContentResponse({ description: 'The current session is revoked.' })
  async logout(@Req() request: AuthenticatedRequest): Promise<void> {
    await this.authService.logout(request.accessToken);
  }

  @Post('logout-all')
  @HttpCode(HttpStatus.NO_CONTENT)
  @UseGuards(AuthGuard)
  @AllowRestricted()
  @ApiOperation({
    summary: 'Log out all sessions',
    description: 'Also available to suspended and banned accounts.',
  })
  @ApiAuthenticated({ allowRestricted: true })
  @ApiNoContentResponse({
    description: 'All sessions of the user are revoked.',
  })
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
